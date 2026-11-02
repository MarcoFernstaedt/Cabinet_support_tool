using System.Buffers.Binary;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Xunit;
using Xunit.Abstractions;
using static Cabinet.Agent.Core.Tests.Fixtures;

namespace Cabinet.Agent.Core.Tests;

/// <summary>
/// database.connectivity against servers made here: one that answers the pre-login and runs TLS inside TDS as SQL Server does, and the
/// hostile and broken ones a check on a client's network can meet. Plus a real SQL Server when TEST_SQLSERVER_ENDPOINT names one.
/// </summary>
public sealed class SqlConnectivityTests(ITestOutputHelper output)
{
    private static void MatchesContract(DatabaseConnectivityOutput o) =>
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.DatabaseConnectivity), JsonSerializer.SerializeToElement(o, ContractJson.Options)));

    /// <summary>A listener on loopback that hands each connection to <paramref name="serve"/>; disposed at the end of the test.</summary>
    private sealed class FakeServer : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _loop;
        public int Port { get; }

        public FakeServer(Func<NetworkStream, CancellationToken, Task> serve)
        {
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _loop = Task.Run(async () =>
            {
                while (!_stop.IsCancellationRequested)
                {
                    TcpClient client;
                    try { client = await _listener.AcceptTcpClientAsync(_stop.Token); } catch { return; }
                    _ = Task.Run(async () => { using (client) { try { await serve(client.GetStream(), _stop.Token); } catch { /* the client hung up */ } } });
                }
            });
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            try { await _loop; } catch { }
        }
    }

    /// <summary>A pre-login answer: version 16.0.4305 and the given encryption byte, in a tabular-result packet.</summary>
    private static byte[] PreloginAnswer(byte encryption, byte type = 0x04)
    {
        byte[] payload = [0x00, 0, 11, 0, 6, 0x01, 0, 17, 0, 1, 0xFF, 16, 0, 0x10, 0xD1, 0, 0, encryption];
        var packet = new byte[8 + payload.Length];
        packet[0] = type; packet[1] = 1;
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(2), (ushort)packet.Length);
        payload.CopyTo(packet, 8);
        return packet;
    }

    private static async Task ReadPreloginRequest(NetworkStream s, CancellationToken t)
    {
        var header = new byte[8];
        await s.ReadExactlyAsync(header, t);
        Assert.Equal(0x12, header[0]); // a pre-login, and nothing else, comes first
        await s.ReadExactlyAsync(new byte[BinaryPrimitives.ReadUInt16BigEndian(header.AsSpan(2)) - 8], t);
    }

    private static X509Certificate2 SelfSigned(string name)
    {
        using RSA key = RSA.Create(2048);
        var request = new CertificateRequest($"CN={name}", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        using X509Certificate2 made = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
        return X509CertificateLoader.LoadPkcs12(made.Export(X509ContentType.Pfx), null);
    }

    [Fact]
    public async Task A_sql_server_that_answers_the_pre_login_is_named_with_its_version_and_the_certificate_it_presents()
    {
        using X509Certificate2 certificate = SelfSigned("fake-sql");
        await using var server = new FakeServer(async (s, t) =>
        {
            await ReadPreloginRequest(s, t);
            await s.WriteAsync(PreloginAnswer(0x00), t);
            await using var tls = new SslStream(new SqlConnectivity.TdsFramedStream(s), leaveInnerStreamOpen: true);
            await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = certificate }, t);
        });

        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(IPAddress.Loopback, server.Port, CancellationToken.None);

        Assert.Equal(DatabaseConnectivityResult.SqlServer, o.Result);
        Assert.True(o.Tcp.Connected);
        Assert.Equal("16.0.4305", o.Prelogin!.ServerVersion);
        Assert.Equal(PreloginEncryption.Off, o.Prelogin.Encryption);
        Assert.NotNull(o.Tls);
        Assert.False(o.Tls!.Completed); // a self-signed certificate is not trusted, so the handshake stops; it was still read
        Assert.Equal("CN=fake-sql", o.Tls.Certificate!.Subject);
        Assert.True(o.Tls.Certificate.SelfSigned);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(certificate.RawData)), o.Tls.Certificate.Sha256);
        Assert.Contains(TlsProblem.UntrustedChain, o.Tls.Problems);
        Assert.Contains(TlsProblem.NameMismatch, o.Tls.Problems); // CN=fake-sql does not name 127.0.0.1
        Assert.Null(o.Error);
        MatchesContract(o);
    }

    [Fact]
    public async Task A_server_that_does_not_support_encryption_is_still_sql_server_and_no_handshake_is_tried()
    {
        await using var server = new FakeServer(async (s, t) => { await ReadPreloginRequest(s, t); await s.WriteAsync(PreloginAnswer(0x02), t); await Task.Delay(-1, t); });
        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(IPAddress.Loopback, server.Port, CancellationToken.None);
        Assert.Equal(DatabaseConnectivityResult.SqlServer, o.Result);
        Assert.Equal(PreloginEncryption.NotSupported, o.Prelogin!.Encryption);
        Assert.Null(o.Tls);
        MatchesContract(o);
    }

    [Fact]
    public async Task A_closed_port_is_refused()
    {
        int port;
        using (var probe = new TcpListener(IPAddress.Loopback, 0)) { probe.Start(); port = ((IPEndPoint)probe.LocalEndpoint).Port; }
        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(IPAddress.Loopback, port, CancellationToken.None);
        Assert.Equal(DatabaseConnectivityResult.Refused, o.Result);
        Assert.False(o.Tcp.Connected);
        Assert.Null(o.Prelogin);
        Assert.Contains("refused", o.Error);
        MatchesContract(o);
    }

    [Fact]
    public async Task Something_else_listening_on_the_port_is_not_sql_server()
    {
        await using var server = new FakeServer(async (s, t) =>
        {
            await ReadPreloginRequest(s, t);
            await s.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"), t);
        });
        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(IPAddress.Loopback, server.Port, CancellationToken.None);
        Assert.Equal(DatabaseConnectivityResult.NotSqlServer, o.Result);
        Assert.True(o.Tcp.Connected);
        Assert.False(o.Prelogin!.Answered);
        Assert.Null(o.Tls);
        MatchesContract(o);
    }

    [Fact]
    public async Task A_listener_that_never_answers_is_given_up_on_at_the_step_limit()
    {
        await using var server = new FakeServer((_, t) => Task.Delay(-1, t));
        var started = DateTime.UtcNow;
        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(IPAddress.Loopback, server.Port, CancellationToken.None);
        TimeSpan took = DateTime.UtcNow - started;
        Assert.Equal(DatabaseConnectivityResult.NotSqlServer, o.Result);
        Assert.Contains("sent nothing back", o.Error);
        Assert.InRange(took, SqlConnectivity.StepTimeout - TimeSpan.FromMilliseconds(500), SqlConnectivity.StepTimeout + TimeSpan.FromSeconds(3));
        MatchesContract(o);
    }

    [Theory]
    [InlineData(0x12)]   // a pre-login packet type, but an answer must be a tabular result
    [InlineData(0x17)]   // a TLS record, not TDS
    public async Task An_answer_of_the_wrong_packet_type_is_not_sql_server(byte type)
    {
        await using var server = new FakeServer(async (s, t) => { await ReadPreloginRequest(s, t); await s.WriteAsync(PreloginAnswer(0x00, type), t); });
        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(IPAddress.Loopback, server.Port, CancellationToken.None);
        Assert.Equal(DatabaseConnectivityResult.NotSqlServer, o.Result);
        MatchesContract(o);
    }

    [Fact]
    public async Task A_server_that_answers_the_handshake_with_junk_ends_it_without_a_certificate_and_nothing_hangs()
    {
        await using var server = new FakeServer(async (s, t) =>
        {
            await ReadPreloginRequest(s, t);
            await s.WriteAsync(PreloginAnswer(0x01), t);
            var junk = new byte[SqlConnectivity.MaxPacket];
            junk[0] = 0x12; junk[1] = 1;
            BinaryPrimitives.WriteUInt16BigEndian(junk.AsSpan(2), (ushort)junk.Length);
            for (int i = 0; i < 40; i++) await s.WriteAsync(junk, t); // 160 KB of framed bytes, past the 64 KB cap
        });
        var started = DateTime.UtcNow;
        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(IPAddress.Loopback, server.Port, CancellationToken.None);
        Assert.Equal(DatabaseConnectivityResult.SqlServer, o.Result);
        Assert.False(o.Tls!.Completed);
        Assert.Null(o.Tls.Certificate);
        Assert.Contains(TlsProblem.Missing, o.Tls.Problems);
        Assert.True(DateTime.UtcNow - started < SqlConnectivity.StepTimeout, "ended by the bad data, not the clock");
        MatchesContract(o);
    }

    [Fact]
    public async Task A_cabinet_with_no_sync_cabinet_says_so_and_connects_nowhere()
    {
        DatabaseConnectivityOutput o = await new SqlConnectivity(Config()).RunAsync(new DatabaseConnectivityParams { Port = 1433 }, CancellationToken.None);
        Assert.Equal(DatabaseConnectivityResult.NoSyncCabinet, o.Result);
        Assert.Null(o.Address);
        Assert.False(o.Tcp.Connected);
        MatchesContract(o);
    }

    /// <summary>
    /// An address that is not IPv4 is nothing to check, not a result the platform refuses to record. The contract's
    /// address is an IPv4 string, so putting ::1 or fd00::1 in it loses the whole output, the same way
    /// reliability.list lost its output over a 300 character message.
    /// </summary>
    [Fact]
    public async Task A_sync_cabinet_address_that_is_not_ipv4_is_nothing_to_check()
    {
        DatabaseConnectivityOutput o = await new SqlConnectivity(Config(sync: "fd00::1"))
            .RunAsync(new DatabaseConnectivityParams { Port = 1433 }, CancellationToken.None);
        Assert.Equal(DatabaseConnectivityResult.NoSyncCabinet, o.Result);
        Assert.Null(o.Address);
        Assert.False(o.Tcp.Connected);
        MatchesContract(o);
    }

    [Fact]
    public void The_pre_login_sent_carries_no_name_no_credential_and_reads_back_as_a_pre_login()
    {
        byte[] request = SqlConnectivity.PreloginRequest();
        Assert.Equal(0x12, request[0]);
        Assert.Equal(request.Length, BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(2)));
        Assert.Equal(47, request.Length); // header, five options, terminator, 13 bytes of data: nothing else fits
        Assert.All(request.AsSpan(8 + 26).ToArray(), b => Assert.Equal(0, b)); // version 0, encryption off, default instance, thread 0, no MARS
        SqlConnectivity.Prelogin? own = SqlConnectivity.ParsePrelogin(request.AsSpan(8));
        Assert.Equal("0.0.0", own!.Version);
        Assert.Equal(PreloginEncryption.Off, own.Encryption);
    }

    [Fact]
    public async Task The_handshake_stream_stops_reading_past_its_size_limit_and_refuses_oversized_or_foreign_packets()
    {
        // Well-formed pre-login packets, each 4 KB, more of them than the cap allows.
        var flood = new MemoryStream();
        var packet = new byte[SqlConnectivity.MaxPacket];
        packet[0] = 0x12; packet[1] = 1;
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(2), (ushort)packet.Length);
        for (int i = 0; i < SqlConnectivity.MaxHandshakeBytes / SqlConnectivity.MaxPacket + 4; i++) flood.Write(packet);
        flood.Position = 0;
        var framed = new SqlConnectivity.TdsFramedStream(flood);
        var buffer = new byte[SqlConnectivity.MaxPacket];
        long read = 0;
        await Assert.ThrowsAsync<InvalidDataException>(async () => { while (true) { int n = await framed.ReadAsync(buffer); if (n == 0) break; read += n; } });
        Assert.True(read <= SqlConnectivity.MaxHandshakeBytes, $"read {read} bytes");

        // A packet claiming to be larger than the protocol allows, and one that is not TDS at all.
        foreach (byte[] bad in new[] { new byte[] { 0x12, 1, 0xFF, 0xFF, 0, 0, 1, 0 }, new byte[] { 0x16, 3, 3, 0, 5, 0, 0, 0 } })
            await Assert.ThrowsAsync<InvalidDataException>(async () => { int n = await new SqlConnectivity.TdsFramedStream(new MemoryStream(bad)).ReadAsync(buffer); Assert.Fail($"read {n} bytes"); });
    }

    public static IEnumerable<object[]> Malformed() => new[]
    {
        new object[] { "empty", Array.Empty<byte>() },
        new object[] { "no terminator", new byte[] { 0x00, 0, 5, 0, 6 } },
        new object[] { "option cut short", new byte[] { 0x00, 0, 5 } },
        new object[] { "offset past the end", new byte[] { 0x00, 0xFF, 0xF0, 0, 6, 0xFF } },
        new object[] { "length past the end", new byte[] { 0x00, 0, 6, 0x7F, 0xFF, 0xFF } },
        new object[] { "no version", new byte[] { 0x01, 0, 6, 0, 1, 0xFF, 0 } },
        new object[] { "no encryption", new byte[] { 0x00, 0, 6, 0, 6, 0xFF, 16, 0, 0, 1, 0, 0 } },
        new object[] { "unknown encryption value", new byte[] { 0x00, 0, 11, 0, 6, 0x01, 0, 17, 0, 1, 0xFF, 16, 0, 0, 1, 0, 0, 9 } },
    };

    [Theory]
    [MemberData(nameof(Malformed))]
    public void A_malformed_pre_login_answer_is_refused_whole(string what, byte[] payload) =>
        Assert.True(SqlConnectivity.ParsePrelogin(payload) is null, what);

    /// <summary>A real SQL Server, named by TEST_SQLSERVER_ENDPOINT (the Linux CI job sets it; locally: TEST_SQLSERVER_ENDPOINT=127.0.0.1:1433).</summary>
    [Fact]
    public async Task A_real_sql_server_answers_as_sql_server()
    {
        string? endpoint = Environment.GetEnvironmentVariable("TEST_SQLSERVER_ENDPOINT");
        // Never a quiet pass. With the endpoint missing this test has verified nothing, and counting it as passed is
        // how the one check that needs a real server gets reported as covered. Same shape as PACKAGE_FIXTURES.
        Assert.False(string.IsNullOrWhiteSpace(endpoint),
            "TEST_SQLSERVER_ENDPOINT is not set — this test needs a real SQL Server (locally: TEST_SQLSERVER_ENDPOINT=127.0.0.1:1433)");
        IPEndPoint target = IPEndPoint.Parse(endpoint!);
        DatabaseConnectivityOutput o = await SqlConnectivity.CheckAsync(target.Address, target.Port, CancellationToken.None);
        output.WriteLine(JsonSerializer.Serialize(o, ContractJson.Options));
        Assert.Equal(DatabaseConnectivityResult.SqlServer, o.Result);
        Assert.Matches(@"^1[0-9]\.", o.Prelogin!.ServerVersion);
        Assert.NotNull(o.Tls?.Certificate);
        MatchesContract(o);
    }
}
