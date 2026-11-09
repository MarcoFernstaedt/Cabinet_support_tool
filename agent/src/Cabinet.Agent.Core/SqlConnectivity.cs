using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core;

/// <summary>
/// database.connectivity: does a SQL Server answer on the sync cabinet? Step by step: a TCP connection, a TDS pre-login (the first
/// message any SQL client sends, before any login), and the TLS handshake that SQL Server runs inside TDS, to read the certificate it
/// presents. That is where it stops. No credential is sent, no login is made, no query runs, and nothing is written over the TLS
/// session (docs/platform/archive/diagnostic-engine-execution.md, decision 7). It runs in the unprivileged network service: the broker never
/// opens a network connection.
///
/// The server at the other end is treated as hostile input: every packet's length is checked against a fixed cap, every option's
/// offset and length against the packet, and the TLS handshake is bounded in bytes and time.
/// </summary>
public sealed class SqlConnectivity
{
    /// <summary>Each step's limit, the same as the single network test's.</summary>
    public static TimeSpan StepTimeout => NetworkTester.Timeout;
    /// <summary>The largest TDS packet accepted (the protocol's default packet size).</summary>
    internal const int MaxPacket = 4096;
    /// <summary>The most a TLS handshake may read before it is abandoned (a certificate chain is a few kilobytes).</summary>
    internal const int MaxHandshakeBytes = 64 * 1024;

    private const byte PreloginType = 0x12, ResponseType = 0x04, EndOfMessage = 0x01;
    private const byte TokenVersion = 0x00, TokenEncryption = 0x01, TokenInstance = 0x02, TokenThread = 0x03, TokenMars = 0x04, TokenEnd = 0xFF;

    private readonly AgentConfig _config;
    public SqlConnectivity(AgentConfig config) => _config = config;

    public async Task<DatabaseConnectivityOutput> RunAsync(DatabaseConnectivityParams p, CancellationToken token)
    {
        IPAddress? address = await AddressAsync(p.SyncAddress ?? _config.SyncCabinet.Address, token).ConfigureAwait(false);
        if (address is null) return Stop(p.Port, null, DatabaseConnectivityResult.NoSyncCabinet, "This cabinet has no sync cabinet address to check.");
        return await CheckAsync(address, p.Port, token).ConfigureAwait(false);
    }

    /// <summary>The check itself, against an address already accepted (the command validator checks it is private and on this network).</summary>
    public static async Task<DatabaseConnectivityOutput> CheckAsync(IPAddress address, int port, CancellationToken token)
    {
        using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        var watch = Stopwatch.StartNew();
        try
        {
            using var limit = Limit(token);
            await socket.ConnectAsync(new IPEndPoint(address, port), limit.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        { return Stop(port, address, DatabaseConnectivityResult.NoAnswer, $"No answer on TCP port {port} within {StepTimeout.TotalSeconds:0} seconds."); }
        catch (SocketException e)
        {
            return e.SocketErrorCode == SocketError.ConnectionRefused
                ? Stop(port, address, DatabaseConnectivityResult.Refused, $"TCP port {port} refused the connection.")
                : Stop(port, address, DatabaseConnectivityResult.Unreachable, $"TCP port {port} could not be reached ({e.SocketErrorCode}).");
        }
        var tcp = new ConnectivityTcpStep { Connected = true, Ms = Round(watch.Elapsed.TotalMilliseconds) };

        await using var stream = new NetworkStream(socket, ownsSocket: false);
        watch.Restart();
        Prelogin? answer;
        string? why;
        try
        {
            using var limit = Limit(token);
            await stream.WriteAsync(PreloginRequest(), limit.Token).ConfigureAwait(false);
            (answer, why) = await ReadPreloginAsync(stream, limit.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { (answer, why) = (null, $"Port {port} accepted the connection but sent nothing back within {StepTimeout.TotalSeconds:0} seconds."); }
        catch (IOException) { (answer, why) = (null, $"Port {port} closed the connection without answering as SQL Server."); }
        double preloginMs = Round(watch.Elapsed.TotalMilliseconds);
        if (answer is null)
        {
            return new DatabaseConnectivityOutput
            {
                Port = port, Address = address.ToString(), Result = DatabaseConnectivityResult.NotSqlServer, Tcp = tcp,
                Prelogin = new ConnectivityPreloginStep { Answered = false, Ms = null, ServerVersion = null, Encryption = null },
                Tls = null, Error = EventText.ShortText(why ?? $"Port {port} answered, but not as SQL Server."),
            };
        }
        var prelogin = new ConnectivityPreloginStep { Answered = true, Ms = preloginMs, ServerVersion = answer.Version, Encryption = answer.Encryption };
        ConnectivityTlsStep? tls = answer.Encryption == PreloginEncryption.NotSupported ? null : await TlsAsync(stream, address, token).ConfigureAwait(false);
        return new DatabaseConnectivityOutput
        {
            Port = port, Address = address.ToString(), Result = DatabaseConnectivityResult.SqlServer, Tcp = tcp, Prelogin = prelogin, Tls = tls, Error = null,
        };
    }

    private static DatabaseConnectivityOutput Stop(int port, IPAddress? address, DatabaseConnectivityResult result, string error) => new()
    {
        Port = port, Address = address?.ToString(), Result = result, Tcp = new ConnectivityTcpStep { Connected = false, Ms = null },
        Prelogin = null, Tls = null, Error = EventText.ShortText(error),
    };

    private static async Task<IPAddress?> AddressAsync(string? configured, CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(configured)) return null;
        // IPv4 only: the contract's address is an IPv4 string, so anything else would be reported as a result the
        // platform refuses to record, and the validator only lets a private IPv4 address through anyway.
        if (IPAddress.TryParse(configured, out IPAddress? ip))
            return ip.AddressFamily == AddressFamily.InterNetwork ? ip : null;
        try
        {
            using var limit = Limit(token);
            IPAddress[] found = await Dns.GetHostAddressesAsync(configured, limit.Token).ConfigureAwait(false);
            return found.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork);
        }
        catch (Exception e) when (e is SocketException or OperationCanceledException && !token.IsCancellationRequested) { return null; }
    }

    private static CancellationTokenSource Limit(CancellationToken token)
    {
        var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(StepTimeout);
        return limit;
    }

    private static double Round(double ms) => Math.Round(ms, 1);

    /// <summary>The pre-login a client sends first: version 0, encryption off (so the answer says whether the server requires it), no instance, no MARS.</summary>
    internal static byte[] PreloginRequest()
    {
        // Five options of five bytes each, the terminator, then their data: version (6), encryption (1), instance (1), thread id (4), MARS (1).
        byte[] options = [TokenVersion, TokenEncryption, TokenInstance, TokenThread, TokenMars];
        int[] lengths = [6, 1, 1, 4, 1];
        int dataStart = options.Length * 5 + 1, payloadLength = dataStart + lengths.Sum();
        var packet = new byte[8 + payloadLength];
        WriteHeader(packet, PreloginType, packet.Length, packetId: 1);
        int at = 8, offset = dataStart;
        for (int i = 0; i < options.Length; i++)
        {
            packet[at] = options[i];
            BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(at + 1), (ushort)offset);
            BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(at + 3), (ushort)lengths[i]);
            at += 5; offset += lengths[i];
        }
        packet[at] = TokenEnd; // the data that follows is all zero: version 0, ENCRYPT_OFF, the default instance, thread 0, no MARS
        return packet;
    }

    private static void WriteHeader(Span<byte> packet, byte type, int length, byte packetId)
    {
        packet[0] = type; packet[1] = EndOfMessage;
        BinaryPrimitives.WriteUInt16BigEndian(packet[2..], (ushort)length);
        packet[4] = 0; packet[5] = 0; packet[6] = packetId; packet[7] = 0;
    }

    internal sealed record Prelogin(string Version, PreloginEncryption Encryption);

    private static async Task<(Prelogin? Answer, string? Why)> ReadPreloginAsync(Stream stream, CancellationToken token)
    {
        var header = new byte[8];
        if (!await ReadExactlyOrEndAsync(stream, header, token).ConfigureAwait(false)) return (null, null);
        int length = BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(2));
        if (header[0] != ResponseType || length < 8 || length > MaxPacket) return (null, null);
        var payload = new byte[length - 8];
        if (!await ReadExactlyOrEndAsync(stream, payload, token).ConfigureAwait(false)) return (null, null);
        return (ParsePrelogin(payload), null);
    }

    /// <summary>Reads a pre-login answer's options. Anything malformed (an offset or length outside the payload, no version) is "not SQL Server", never a guess.</summary>
    internal static Prelogin? ParsePrelogin(ReadOnlySpan<byte> payload)
    {
        string? version = null;
        PreloginEncryption? encryption = null;
        for (int at = 0; ; at += 5)
        {
            if (at >= payload.Length) return null;          // no terminator
            if (payload[at] == TokenEnd) break;
            if (at + 5 > payload.Length) return null;
            byte token = payload[at];
            int offset = BinaryPrimitives.ReadUInt16BigEndian(payload[(at + 1)..]);
            int length = BinaryPrimitives.ReadUInt16BigEndian(payload[(at + 3)..]);
            if (offset > payload.Length || length > payload.Length - offset) return null;
            ReadOnlySpan<byte> data = payload.Slice(offset, length);
            if (token == TokenVersion && length >= 6)
                version = $"{data[0]}.{data[1]}.{BinaryPrimitives.ReadUInt16BigEndian(data[2..])}";
            else if (token == TokenEncryption && length >= 1)
                encryption = data[0] switch { 0 => PreloginEncryption.Off, 1 => PreloginEncryption.On, 2 => PreloginEncryption.NotSupported, 3 => PreloginEncryption.Required, _ => null };
        }
        return version is null || encryption is null ? null : new Prelogin(version, encryption.Value);
    }

    private static async Task<bool> ReadExactlyOrEndAsync(Stream stream, byte[] buffer, CancellationToken token)
    {
        int read = 0;
        while (read < buffer.Length)
        {
            int n = await stream.ReadAsync(buffer.AsMemory(read), token).ConfigureAwait(false);
            if (n == 0) return false;
            read += n;
        }
        return true;
    }

    /// <summary>The TLS handshake inside TDS: records travel in pre-login packets. It ends when the handshake does; nothing is sent over the session.</summary>
    private static async Task<ConnectivityTlsStep> TlsAsync(Stream stream, IPAddress address, CancellationToken token)
    {
        X509Certificate2? presented = null;
        SslPolicyErrors errors = SslPolicyErrors.None;
        var watch = Stopwatch.StartNew();
        bool completed = false;
        string? protocol = null;
        var framed = new TdsFramedStream(stream);
        await using var ssl = new SslStream(framed, leaveInnerStreamOpen: true);
        try
        {
            using var limit = Limit(token);
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
            {
                TargetHost = address.ToString(),
                CertificateRevocationCheckMode = X509RevocationMode.NoCheck, // the cabinets' network has no route to revocation servers
                // The certificate is only recorded. Its own verdict decides whether the handshake completes; either way nothing is sent over it.
                RemoteCertificateValidationCallback = (_, certificate, _, policy) =>
                {
                    if (certificate is not null) presented = new X509Certificate2(certificate);
                    errors = policy;
                    return policy == SslPolicyErrors.None;
                },
            }, limit.Token).ConfigureAwait(false);
            completed = true;
            protocol = (int)ssl.SslProtocol switch { 192 => "tls1.0", 768 => "tls1.1", 3072 => "tls1.2", 12288 => "tls1.3", _ => "other" };
        }
        catch (Exception e) when (!token.IsCancellationRequested && e is AuthenticationException or IOException or InvalidDataException or OperationCanceledException)
        { } // a certificate the server's own checks refuse, a peer that stops, or the step's time limit: what was seen is reported below
        var problems = new List<TlsProblem>();
        if (presented is null) problems.Add(TlsProblem.Missing);
        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch)) problems.Add(TlsProblem.NameMismatch);
        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateChainErrors)) problems.Add(TlsProblem.UntrustedChain);
        using (presented)
        {
            return new ConnectivityTlsStep
            {
                Completed = completed, Ms = Round(watch.Elapsed.TotalMilliseconds), Protocol = protocol,
                Certificate = presented is null ? null : new ConnectivityCertificate
                {
                    Subject = EventText.ShortText(presented.Subject), Issuer = EventText.ShortText(presented.Issuer),
                    NotAfter = new DateTimeOffset(presented.NotAfter.ToUniversalTime(), TimeSpan.Zero),
                    Sha256 = Convert.ToHexStringLower(SHA256.HashData(presented.RawData)),
                    SelfSigned = presented.SubjectName.RawData.AsSpan().SequenceEqual(presented.IssuerName.RawData),
                },
                Problems = problems,
            };
        }
    }

    /// <summary>
    /// Carries TLS records inside TDS pre-login packets, as SQL Server expects during the handshake: each write becomes packets of at most
    /// <see cref="MaxPacket"/> bytes; reads strip each packet's header. Bounded: a peer that sends more than <see cref="MaxHandshakeBytes"/>
    /// or an oversized packet ends the handshake.
    /// </summary>
    internal sealed class TdsFramedStream(Stream inner) : Stream
    {
        private byte[] _packet = [];
        private int _offset, _remaining, _total;
        private byte _packetId = 1;

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_remaining == 0)
            {
                var header = new byte[8];
                if (!await ReadExactlyOrEndAsync(inner, header, cancellationToken).ConfigureAwait(false)) return 0;
                int length = BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(2));
                if ((header[0] != PreloginType && header[0] != ResponseType) || length < 8 || length > MaxPacket)
                    throw new InvalidDataException("The answer was not a TDS packet.");
                _total += length;
                if (_total > MaxHandshakeBytes) throw new InvalidDataException("The handshake ran past its size limit.");
                _packet = new byte[length - 8];
                if (!await ReadExactlyOrEndAsync(inner, _packet, cancellationToken).ConfigureAwait(false)) return 0;
                _offset = 0; _remaining = _packet.Length;
                if (_remaining == 0) return await ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            }
            int n = Math.Min(buffer.Length, _remaining);
            _packet.AsSpan(_offset, n).CopyTo(buffer.Span);
            _offset += n; _remaining -= n;
            return n;
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            for (int at = 0; at < buffer.Length;)
            {
                int n = Math.Min(MaxPacket - 8, buffer.Length - at);
                var packet = new byte[8 + n];
                WriteHeader(packet, PreloginType, packet.Length, _packetId++);
                buffer.Slice(at, n).CopyTo(packet.AsMemory(8));
                await inner.WriteAsync(packet, cancellationToken).ConfigureAwait(false);
                at += n;
            }
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();
        public override void Write(byte[] buffer, int offset, int count) => WriteAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();
        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);
        public override void Flush() => inner.Flush();
        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
