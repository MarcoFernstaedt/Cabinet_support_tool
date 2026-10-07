using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Server;

/// <summary>A server answer the agent will not act on, or a refusal with the server's code.</summary>
public sealed class AgentApiException(HttpStatusCode? status, string code, string message) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
    public string Code { get; } = code;
    public bool CertificateRefused => Status == HttpStatusCode.Unauthorized;
}

/// <summary>
/// The agent's side of docs/spec/03-protocol.md. The server's TLS certificate
/// must chain to the platform CA the installer placed on the cabinet (nothing
/// else is trusted, not even the Windows root store), and every answer is
/// validated against its contract before the agent reads it.
/// </summary>
public sealed class AgentApiClient : IDisposable
{
    public const int MaxResponseBytes = 4 * 1024 * 1024;
    private readonly HttpClient _http;
    private readonly ContractSchemas _schemas = ContractSchemas.Instance;

    /// <summary>The last server time seen, with the local time it arrived, for clock-skew reporting.</summary>
    public (DateTimeOffset Server, DateTimeOffset Local)? LastServerTime { get; private set; }

    /// <param name="clientCertificate">Null for enrollment calls, which are the only ones allowed without a certificate.</param>
    public AgentApiClient(Uri baseAddress, X509Certificate2 platformCa, X509Certificate2? clientCertificate, TimeSpan? timeout = null)
    {
        var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            ConnectTimeout = TimeSpan.FromSeconds(15),
            AllowAutoRedirect = false,
            UseProxy = false,
            UseCookies = false,
            SslOptions = new SslClientAuthenticationOptions
            {
                RemoteCertificateValidationCallback = (_, certificate, _, errors) => PinnedValidation(platformCa, certificate as X509Certificate2, errors),
                ClientCertificates = clientCertificate is null ? null : new X509CertificateCollection { clientCertificate },
                LocalCertificateSelectionCallback = clientCertificate is null ? null : (_, _, _, _, _) => clientCertificate,
            },
        };
        _http = new HttpClient(handler) { BaseAddress = baseAddress, Timeout = timeout ?? TimeSpan.FromSeconds(60), MaxResponseContentBufferSize = MaxResponseBytes };
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("MashuraCabinetAgent", "1"));
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

    public Task<ServerAck> PostResultAsync(Result result, CancellationToken token) =>
        SendAsync<ServerAck>(HttpMethod.Post, "/agent/v1/results", result, "server-ack", token);

    public Task<RenewResponse> RenewAsync(RenewRequest request, CancellationToken token) =>
        SendAsync<RenewResponse>(HttpMethod.Post, "/agent/v1/renew", request, "renew-response", token);

    /// <summary>
    /// Downloads an approved package to <paramref name="destination"/>, streaming it to disk. The server serves it only while a
    /// package.install command for this cabinet is open. The size is capped; the hash is checked again by the broker.
    /// </summary>
    public async Task DownloadPackageAsync(Guid packageId, string destination, long maxBytes, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/agent/v1/packages/{packageId:D}");
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        HttpResponseMessage response;
        try { response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false); }
        catch (HttpRequestException e) { throw new AgentApiException(null, "unreachable", $"The platform server could not be reached ({e.HttpRequestError})."); }
        using (response)
        {
            if (!response.IsSuccessStatusCode)
                throw new AgentApiException(response.StatusCode, "download_refused", $"The platform server refused the package download ({(int)response.StatusCode}).");
            if (response.Content.Headers.ContentLength is > 0 and var length && length > maxBytes)
                throw new AgentApiException(response.StatusCode, "too_large", "The package is larger than any package may be.");
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
                        if (total > maxBytes) throw new AgentApiException(response.StatusCode, "too_large", "The package is larger than any package may be.");
                        await file.WriteAsync(buffer.AsMemory(0, n), token).ConfigureAwait(false);
                    }
                }
                File.Move(temp, destination, overwrite: true);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }

    /// <summary>The long poll. Returns each command as its raw JSON, so the agent's own six checks see exactly what the server sent.</summary>
    public async Task<IReadOnlyList<byte[]>> CommandsAsync(CancellationToken token)
    {
        // Only the outer shape is checked here; each command then goes through the agent's six checks, so a malformed
        // one is answered with a rejection result instead of silently dropping the whole batch.
        using JsonDocument doc = await SendRawAsync(HttpMethod.Get, "/agent/v1/commands", null, null, token).ConfigureAwait(false);
        JsonElement root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("commands", out JsonElement commands) || commands.ValueKind != JsonValueKind.Array ||
            commands.GetArrayLength() > 50 || !root.TryGetProperty("serverTime", out JsonElement time) || !_schemas.IsValid(ContractSchemas.CommonDef("timestamp"), time) ||
            root.EnumerateObject().Count() != 2)
            throw new AgentApiException(HttpStatusCode.OK, "malformed_response", "The platform server's command list does not match the commands-response contract.");
        return commands.EnumerateArray().Select(c => Encoding.UTF8.GetBytes(c.GetRawText())).ToList();
    }

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, string schema, CancellationToken token)
    {
        using JsonDocument doc = await SendRawAsync(method, path, body, schema, token).ConfigureAwait(false);
        return doc.RootElement.Deserialize<T>(ContractJson.Options)!;
    }

    private async Task<JsonDocument> SendRawAsync(HttpMethod method, string path, object? body, string? schema, CancellationToken token)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null)
            request.Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(body, body.GetType(), ContractJson.Options))
            { Headers = { ContentType = new MediaTypeHeaderValue("application/json") } };
        HttpResponseMessage response;
        try { response = await _http.SendAsync(request, token).ConfigureAwait(false); }
        catch (HttpRequestException e) { throw new AgentApiException(null, "unreachable", $"The platform server could not be reached ({e.HttpRequestError})."); }
        catch (TaskCanceledException) when (!token.IsCancellationRequested) { throw new AgentApiException(null, "timeout", "The platform server did not answer in time."); }
        using (response)
        {
            byte[] bytes = await response.Content.ReadAsByteArrayAsync(token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw new AgentApiException(response.StatusCode, ErrorCode(bytes), $"The platform server refused the request ({(int)response.StatusCode} {ErrorCode(bytes)}).");
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

    /// <summary>The server's error code, if it sent one that looks like a code. Anything else is not repeated.</summary>
    private static string ErrorCode(byte[] body)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out JsonElement e) &&
                e.GetString() is { Length: > 0 and <= 40 } code && code.All(c => char.IsAsciiLetterLower(c) || c == '_'))
                return code;
        }
        catch (JsonException) { }
        return "error";
    }

    public void Dispose() => _http.Dispose();
}
