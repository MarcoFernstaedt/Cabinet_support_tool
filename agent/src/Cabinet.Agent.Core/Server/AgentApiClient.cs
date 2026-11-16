using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Server;

/// <summary>A server answer the agent will not act on, or a refusal with the server's code.</summary>
public sealed class AgentApiException(HttpStatusCode? status, string code, string message, TimeSpan? retryAfter = null) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
    public string Code { get; } = code;
    public bool CertificateRefused => Status == HttpStatusCode.Unauthorized;
    /// <summary>The server's Retry-After (503 under load, 429 for quotas), clamped to 0–10 minutes; null when it sent none.</summary>
    public TimeSpan? RetryAfter { get; } = retryAfter;
}

/// <summary>One long-poll answer: the raw commands, and the server's pacing for the next poll (protocol 1.1).</summary>
public sealed record CommandBatch(IReadOnlyList<byte[]> Commands, int? PollSeconds, int? ReconnectAfterMs);

/// <summary>
/// The agent's side of docs/spec/03-protocol.md. The server's TLS certificate
/// must chain to the platform CA the installer placed on the cabinet (nothing
/// else is trusted, not even the Windows root store), and every answer is
/// validated against its contract before the agent reads it.
/// </summary>
public sealed class AgentApiClient : IDisposable
{
    public const int MaxResponseBytes = 4 * 1024 * 1024;
    public const int MaxAck = 50;
    /// <summary>Requests that are not long polls must have their answer within this.</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(60);
    /// <summary>A long poll may take the hold the server set plus this.</summary>
    public static readonly TimeSpan PollMargin = TimeSpan.FromSeconds(35);
    /// <summary>After a 415, request bodies go uncompressed for this long before gzip is tried again.</summary>
    public static readonly TimeSpan GzipRetryAfter = TimeSpan.FromHours(24);
    /// <summary>Bodies smaller than this are not worth compressing.</summary>
    public const int GzipFrom = 1024;

    private static readonly string[] CommandsResponseProperties = ["serverTime", "commands", "pollSeconds", "reconnectAfterMs"];

    private readonly ContractSchemas _schemas = ContractSchemas.Instance;
    private readonly Uri _baseAddress;
    private readonly X509Certificate2 _platformCa;
    private readonly Func<X509Certificate2?, HttpMessageHandler>? _handlerFactory;
    private readonly object _swapGate = new();
    private readonly List<HttpClient> _retired = new();
    private volatile HttpClient _http;
    private long _gzipRefusedAtTicks;
    private bool _disposed;

    /// <summary>The last server time seen, with the local time it arrived, for clock-skew reporting.</summary>
    public (DateTimeOffset Server, DateTimeOffset Local)? LastServerTime { get; private set; }

    /// <param name="clientCertificate">Null for enrollment calls, which are the only ones allowed without a certificate.</param>
    /// <param name="handlerFactory">Tests only: replaces the real TLS handler (called again for each renewed certificate).</param>
    public AgentApiClient(Uri baseAddress, X509Certificate2 platformCa, X509Certificate2? clientCertificate, Func<X509Certificate2?, HttpMessageHandler>? handlerFactory = null)
    {
        _baseAddress = baseAddress;
        _platformCa = platformCa;
        _handlerFactory = handlerFactory;
        _http = NewClient(clientCertificate);
    }

    /// <summary>
    /// Whether request bodies may be gzip-compressed. The connection sets it once the server has shown it speaks
    /// protocol 1.1 (a 1.0 server never sees a compressed body); a 415 turns compression off for a day.
    /// </summary>
    public bool GzipAllowed { get; set; }

    private bool GzipNow
    {
        get
        {
            if (!GzipAllowed) return false;
            long at = Interlocked.Read(ref _gzipRefusedAtTicks);
            return at == 0 || DateTime.UtcNow.Ticks - at > GzipRetryAfter.Ticks;
        }
    }

    private HttpClient NewClient(X509Certificate2? clientCertificate)
    {
        HttpMessageHandler handler = _handlerFactory?.Invoke(clientCertificate) ?? CreateHandler(_platformCa, clientCertificate);
        var http = new HttpClient(handler) { BaseAddress = _baseAddress, Timeout = Timeout.InfiniteTimeSpan, MaxResponseContentBufferSize = MaxResponseBytes };
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("MashuraCabinetAgent", "1"));
        return http;
    }

    /// <summary>
    /// One long-lived connection (protocol 1.1): HTTP/2 where the server offers it, pinged every 20 s so a dead NAT
    /// mapping is found within half a minute; otherwise HTTP/1.1 keep-alive with TCP keepalives after 20 s idle, every 5 s.
    /// A full TLS handshake then happens about once a day (the lifetime is jittered so a fleet does not renew in step).
    /// Trust is exactly as strict as before: only the pinned platform CA, and this cabinet's own certificate. No proxy
    /// (proxy support is an open decision).
    /// </summary>
    public static SocketsHttpHandler CreateHandler(X509Certificate2 platformCa, X509Certificate2? clientCertificate) => new()
    {
        PooledConnectionLifetime = TimeSpan.FromHours(23) + TimeSpan.FromMinutes(Random.Shared.Next(0, 120)),
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(20),
        KeepAlivePingDelay = TimeSpan.FromSeconds(20),
        KeepAlivePingTimeout = TimeSpan.FromSeconds(10),
        KeepAlivePingPolicy = HttpKeepAlivePingPolicy.Always,
        ConnectTimeout = TimeSpan.FromSeconds(15),
        ConnectCallback = ConnectWithKeepAliveAsync,
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.None,
        SslOptions = new SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = (_, certificate, _, errors) => PinnedValidation(platformCa, certificate as X509Certificate2, errors),
            ClientCertificates = clientCertificate is null ? null : new X509CertificateCollection { clientCertificate },
            LocalCertificateSelectionCallback = clientCertificate is null ? null : (_, _, _, _, _) => clientCertificate,
        },
    };

    /// <summary>Opens the TCP connection with keepalive on (20 s idle, then every 5 s), so an HTTP/1.1 connection through a NAT stays mapped and a dead one is noticed.</summary>
    public static async ValueTask<Stream> ConnectWithKeepAliveAsync(SocketsHttpConnectionContext context, CancellationToken token)
    {
        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            ConfigureKeepAlive(socket);
            await socket.ConnectAsync(context.DnsEndPoint, token).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    public static void ConfigureKeepAlive(Socket socket)
    {
        socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
        socket.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveTime, 20);
        socket.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveInterval, 5);
    }

    /// <summary>
    /// A renewed certificate: new requests use it on a new connection; requests already running finish on the old one
    /// (a safety-net result in flight is never cut off). The old connection is closed once the longest request could have ended.
    /// </summary>
    public void SwapClientCertificate(X509Certificate2 clientCertificate)
    {
        HttpClient old;
        lock (_swapGate)
        {
            if (_disposed) return;
            old = _http;
            _http = NewClient(clientCertificate);
            _retired.Add(old);
        }
        _ = Task.Delay(RequestTimeout + PollMargin + TimeSpan.FromSeconds(110)).ContinueWith(_ =>
        {
            lock (_swapGate) { if (!_retired.Remove(old)) return; }
            old.Dispose();
        }, TaskScheduler.Default);
    }

    /// <summary>The server must present a certificate for the configured host name that chains to the platform CA, and only to it.</summary>
    public static bool PinnedValidation(X509Certificate2 platformCa, X509Certificate2? presented, SslPolicyErrors errors)
    {
        if (presented is null) return false;
        if ((errors & (SslPolicyErrors.RemoteCertificateNotAvailable | SslPolicyErrors.RemoteCertificateNameMismatch)) != 0) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(platformCa);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.ApplicationPolicy.Add(new System.Security.Cryptography.Oid("1.3.6.1.5.5.7.3.1")); // serverAuth
        return chain.Build(presented) && chain.ChainElements[^1].Certificate.Thumbprint == platformCa.Thumbprint;
    }

    public Task<EnrollResponse> EnrollAsync(EnrollRequest request, CancellationToken token) =>
        SendAsync<EnrollResponse>(HttpMethod.Post, "/agent/v1/enroll", request, "enroll-response", token);

    public Task<EnrollStatus> EnrollStatusAsync(Guid requestId, CancellationToken token) =>
        SendAsync<EnrollStatus>(HttpMethod.Get, $"/agent/v1/enroll/{requestId:D}", null, "enroll-status", token);

    public Task<HeartbeatResponse> HeartbeatAsync(Heartbeat heartbeat, CancellationToken token) =>
        SendAsync<HeartbeatResponse>(HttpMethod.Post, "/agent/v1/heartbeat", heartbeat, "heartbeat-response", token);

    public Task<ServerAck> PostEventsAsync(EventBatch batch, CancellationToken token) =>
        SendAsync<ServerAck>(HttpMethod.Post, "/agent/v1/events", batch, "server-ack", token);

    /// <summary>
    /// Posts queued events exactly as they were checked and stored, gzip-compressed when allowed (Content-Encoding: gzip).
    /// A 415 turns compression off and the same batch goes again uncompressed at once.
    /// </summary>
    public async Task PostEventsRawAsync(IReadOnlyList<string> eventsJson, CancellationToken token)
    {
        byte[] bytes = EventsBody(eventsJson);
        if (GzipNow && bytes.Length >= GzipFrom)
        {
            try
            {
                using JsonDocument _ = await SendBytesAsync(HttpMethod.Post, "/agent/v1/events", Gzip(bytes), "gzip", "server-ack", RequestTimeout, token).ConfigureAwait(false);
                return;
            }
            catch (AgentApiException e) when (e.Status == HttpStatusCode.UnsupportedMediaType)
            {
                Interlocked.Exchange(ref _gzipRefusedAtTicks, DateTime.UtcNow.Ticks);
            }
        }
        using JsonDocument __ = await SendBytesAsync(HttpMethod.Post, "/agent/v1/events", bytes, null, "server-ack", RequestTimeout, token).ConfigureAwait(false);
    }

    /// <summary>The event-batch envelope around events already in their contract's JSON form.</summary>
    public static byte[] EventsBody(IReadOnlyList<string> eventsJson)
    {
        var body = new StringBuilder("{\"events\":[");
        for (int i = 0; i < eventsJson.Count; i++) { if (i > 0) body.Append(','); body.Append(eventsJson[i]); }
        return Encoding.UTF8.GetBytes(body.Append("]}").ToString());
    }

    public static byte[] Gzip(byte[] bytes)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true)) gzip.Write(bytes);
        return output.ToArray();
    }

    /// <summary>Posts configuration snapshots exactly as the queue checked and stored them (the body is the config-upload envelope).</summary>
    public async Task PostConfigAsync(string body, CancellationToken token)
    {
        using JsonDocument _ = await SendBytesAsync(HttpMethod.Post, "/agent/v1/config", Encoding.UTF8.GetBytes(body), null, "server-ack", RequestTimeout, token).ConfigureAwait(false);
    }

    public Task<ServerAck> PostResultAsync(Result result, CancellationToken token) =>
        SendAsync<ServerAck>(HttpMethod.Post, "/agent/v1/results", result, "server-ack", token);

    /// <summary>Posts a result exactly as stored in the outbox (already checked against the result contract).</summary>
    public async Task PostResultRawAsync(byte[] resultJson, CancellationToken token)
    {
        using JsonDocument _ = await SendBytesAsync(HttpMethod.Post, "/agent/v1/results", resultJson, null, "server-ack", RequestTimeout, token).ConfigureAwait(false);
    }

    public Task<RenewResponse> RenewAsync(RenewRequest request, CancellationToken token) =>
        SendAsync<RenewResponse>(HttpMethod.Post, "/agent/v1/renew", request, "renew-response", token);

    /// <summary>
    /// Downloads an approved package to <paramref name="destination"/>, streaming it to disk. The server serves it only while a
    /// package.install command for this cabinet is open. The size is capped; the hash is checked again by the broker.
    /// </summary>
    public Task DownloadPackageAsync(Guid packageId, string destination, long maxBytes, CancellationToken token) =>
        DownloadAsync($"/agent/v1/packages/{packageId:D}", destination, maxBytes, "package", token);

    /// <summary>An offered agent release's manifest (exactly as signed) and signature. Served only while this cabinet is offered it.</summary>
    public Task<UpdateResponse> GetUpdateAsync(string version, CancellationToken token) =>
        SendAsync<UpdateResponse>(HttpMethod.Get, $"/agent/v1/updates/{Uri.EscapeDataString(version)}", null, "update-response", token);

    /// <summary>The offered release's package zip, streamed to disk with a size cap. The broker checks it; this side does not.</summary>
    public Task DownloadUpdateAsync(string version, string destination, long maxBytes, CancellationToken token) =>
        DownloadAsync($"/agent/v1/updates/{Uri.EscapeDataString(version)}/package", destination, maxBytes, "release", token);

    public Task<ServerAck> PostUpgradeStatusAsync(UpgradeStatus status, CancellationToken token) =>
        SendAsync<ServerAck>(HttpMethod.Post, "/agent/v1/upgrade-status", status, "server-ack", token);

    private async Task DownloadAsync(string path, string destination, long maxBytes, string what, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        Prepare(request);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        HttpResponseMessage response;
        using (var headers = CancellationTokenSource.CreateLinkedTokenSource(token))
        {
            headers.CancelAfter(RequestTimeout);
            try { response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, headers.Token).ConfigureAwait(false); }
            catch (HttpRequestException e) { throw new AgentApiException(null, "unreachable", $"The platform server could not be reached ({e.HttpRequestError})."); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new AgentApiException(null, "timeout", "The platform server did not answer in time."); }
        }
        using (response)
        {
            if (!response.IsSuccessStatusCode)
                throw new AgentApiException(response.StatusCode, "download_refused", $"The platform server refused the {what} download ({(int)response.StatusCode}).", RetryAfterOf(response));
            if (response.Content.Headers.ContentLength is > 0 and var length && length > maxBytes)
                throw new AgentApiException(response.StatusCode, "too_large", $"The {what} is larger than allowed.");
            string temp = destination + ".part";
            try
            {
                await using (Stream body = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false))
                await using (var file = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    byte[] buffer = new byte[81920];
                    long total = 0;
                    int n;
                    while ((n = await body.ReadAsync(buffer, token).ConfigureAwait(false)) > 0)
                    {
                        total += n;
                        if (total > maxBytes) throw new AgentApiException(response.StatusCode, "too_large", $"The {what} is larger than allowed.");
                        await file.WriteAsync(buffer.AsMemory(0, n), token).ConfigureAwait(false);
                    }
                }
                File.Move(temp, destination, overwrite: true);
            }
            catch (HttpRequestException e) { throw new AgentApiException(null, "unreachable", $"The {what} download was cut off ({e.HttpRequestError})."); }
            catch (IOException) when (!token.IsCancellationRequested && !File.Exists(destination)) { throw new AgentApiException(null, "unreachable", $"The {what} download was cut off."); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }

    /// <summary>
    /// The long poll (protocol 1.1). <paramref name="ack"/> names commands received on the previous poll (at most 50 are sent);
    /// the request may take the server's hold plus a margin. Returns each command as its raw JSON, so the agent's own six checks
    /// see exactly what the server sent.
    /// </summary>
    public async Task<CommandBatch> CommandsAsync(IReadOnlyCollection<Guid> ack, int pollSeconds, CancellationToken token)
    {
        string path = "/agent/v1/commands";
        if (ack.Count > 0) path += "?ack=" + string.Join(",", ack.Take(MaxAck).Select(id => id.ToString("D")));
        TimeSpan timeout = TimeSpan.FromSeconds(Math.Clamp(pollSeconds, 15, 110)) + PollMargin;
        // Only the outer shape is checked here; each command then goes through the agent's six checks, so a malformed
        // one is answered with a rejection result instead of silently dropping the whole batch.
        using JsonDocument doc = await SendBytesAsync(HttpMethod.Get, path, null, null, null, timeout, token).ConfigureAwait(false);
        JsonElement root = doc.RootElement;
        static AgentApiException Malformed() =>
            new(HttpStatusCode.OK, "malformed_response", "The platform server's command list does not match the commands-response contract.");
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("commands", out JsonElement commands) || commands.ValueKind != JsonValueKind.Array ||
            commands.GetArrayLength() > 50 || !root.TryGetProperty("serverTime", out JsonElement time) || !_schemas.IsValid(ContractSchemas.CommonDef("timestamp"), time))
            throw Malformed();
        int? poll = null, reconnect = null;
        foreach (JsonProperty property in root.EnumerateObject())
        {
            if (Array.IndexOf(CommandsResponseProperties, property.Name) < 0) throw Malformed();
            if (property.Name is not ("pollSeconds" or "reconnectAfterMs")) continue;
            if (!_schemas.IsValid($"{ContractSchemas.Envelope("commands-response")}#/properties/{property.Name}", property.Value)) throw Malformed();
            if (property.Name == "pollSeconds") poll = property.Value.GetInt32(); else reconnect = property.Value.GetInt32();
        }
        return new CommandBatch(commands.EnumerateArray().Select(c => Encoding.UTF8.GetBytes(c.GetRawText())).ToList(), poll, reconnect);
    }

    /// <summary>Opaque bounded bytes over the existing outbound mTLS client; never command dispatch.</summary>
    public async Task<byte[]> ExchangeSessionFrameAsync(Guid sessionId, byte[] bytes, CancellationToken token)
    {
        if (bytes.Length > 16_384) throw new ArgumentOutOfRangeException(nameof(bytes));
        var frame = await SendAsync<SessionTransportFrame>(HttpMethod.Post,
            $"/agent/v1/sessions/{sessionId:D}/frames", new SessionTransportFrame(Convert.ToBase64String(bytes)),
            "session-frame", token).ConfigureAwait(false);
        byte[] received = Convert.FromBase64String(frame.Data);
        if (received.Length > 16_384) throw new InvalidDataException("Session frame exceeds the transport limit.");
        return received;
    }

    private sealed record SessionTransportFrame(string Data);

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, string schema, CancellationToken token)
    {
        using JsonDocument doc = await SendBytesAsync(method, path, body is null ? null : JsonSerializer.SerializeToUtf8Bytes(body, body.GetType(), ContractJson.Options),
            null, schema, RequestTimeout, token).ConfigureAwait(false);
        return doc.RootElement.Deserialize<T>(ContractJson.Options)!;
    }

    /// <summary>HTTP/2 preferred, HTTP/1.1 when the server does not offer it (ALPN decides; nothing is sent in clear text).</summary>
    private static void Prepare(HttpRequestMessage request)
    {
        request.Version = HttpVersion.Version20;
        request.VersionPolicy = HttpVersionPolicy.RequestVersionOrLower;
    }

    private async Task<JsonDocument> SendBytesAsync(HttpMethod method, string path, byte[]? body, string? encoding, string? schema, TimeSpan timeout, CancellationToken token)
    {
        using var request = new HttpRequestMessage(method, path);
        Prepare(request);
        if (body is not null)
        {
            request.Content = new ByteArrayContent(body) { Headers = { ContentType = new MediaTypeHeaderValue("application/json") } };
            if (encoding is not null) request.Content.Headers.ContentEncoding.Add(encoding);
        }
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(timeout);
        HttpResponseMessage response;
        try { response = await _http.SendAsync(request, limit.Token).ConfigureAwait(false); }
        catch (HttpRequestException e) { throw new AgentApiException(null, "unreachable", $"The platform server could not be reached ({e.HttpRequestError})."); }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new AgentApiException(null, "timeout", "The platform server did not answer in time."); }
        using (response)
        {
            byte[] bytes;
            try { bytes = await response.Content.ReadAsByteArrayAsync(limit.Token).ConfigureAwait(false); }
            catch (HttpRequestException e) { throw new AgentApiException(null, "unreachable", $"The platform server's answer was cut off or too large ({e.HttpRequestError})."); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new AgentApiException(null, "timeout", "The platform server did not answer in time."); }
            catch (IOException) { throw new AgentApiException(null, "unreachable", "The platform server's answer was cut off."); }
            if (!response.IsSuccessStatusCode)
                throw new AgentApiException(response.StatusCode, ErrorCode(bytes), $"The platform server refused the request ({(int)response.StatusCode} {ErrorCode(bytes)}).", RetryAfterOf(response));
            if (!StrictJson.TryParse(bytes, MaxResponseBytes, out JsonDocument? doc))
                throw new AgentApiException(response.StatusCode, "malformed_response", "The platform server's answer is not valid JSON.");
            if (schema is not null && !_schemas.IsValid(ContractSchemas.Envelope(schema), doc!.RootElement))
            {
                doc.Dispose();
                throw new AgentApiException(response.StatusCode, "malformed_response", $"The platform server's answer does not match the {schema} contract.");
            }
            if (doc!.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("serverTime", out JsonElement serverTime) && serverTime.TryGetDateTimeOffset(out DateTimeOffset at))
                LastServerTime = (at, DateTimeOffset.UtcNow);
            return doc;
        }
    }

    /// <summary>The server's Retry-After, as seconds or a date, clamped to 0–10 minutes so no answer can park the agent for longer.</summary>
    public static TimeSpan? RetryAfterOf(HttpResponseMessage response)
    {
        RetryConditionHeaderValue? header = response.Headers.RetryAfter;
        TimeSpan? wait = header?.Delta ?? (header?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
        if (wait is not { } w) return null;
        return w < TimeSpan.Zero ? TimeSpan.Zero : w > Connectivity.MaxServerWait ? Connectivity.MaxServerWait : w;
    }

    /// <summary>The server's error code, if it sent one that looks like a code. Anything else is not repeated.</summary>
    private static string ErrorCode(byte[] body)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out JsonElement e) &&
                e.ValueKind == JsonValueKind.String && e.GetString() is { Length: > 0 and <= 40 } code && code.All(c => char.IsAsciiLetterLower(c) || c == '_'))
                return code;
        }
        catch (JsonException) { }
        return "error";
    }

    public void Dispose()
    {
        List<HttpClient> all;
        lock (_swapGate) { _disposed = true; all = [.. _retired, _http]; _retired.Clear(); }
        foreach (HttpClient client in all) client.Dispose();
    }
}
