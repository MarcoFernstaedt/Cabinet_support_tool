using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

public sealed class BackoffTests
{
    [Fact]
    public void Delays_grow_with_jitter_and_never_exceed_five_minutes()
    {
        var backoff = new Backoff(random: new Random(7));
        var delays = Enumerable.Range(0, 30).Select(_ => backoff.Next()).ToList();
        Assert.All(delays, d => Assert.InRange(d, TimeSpan.FromSeconds(2), TimeSpan.FromMinutes(5)));
        Assert.True(delays.Skip(10).Average(d => d.TotalSeconds) > 60, "later attempts wait much longer");
        Assert.True(delays.Skip(10).Distinct().Count() > 10, "jittered, so a fleet does not retry in step");
        // Decorrelated: each wait is between the base and three times the previous one.
        for (int i = 1; i < delays.Count; i++)
            Assert.True(delays[i] <= TimeSpan.FromTicks(Math.Max(delays[i - 1].Ticks * 3, TimeSpan.FromSeconds(2).Ticks)) + TimeSpan.FromMilliseconds(1));
        backoff.Reset();
        Assert.InRange(backoff.Next(), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(6));
    }
}

public sealed class IdentityStoreTests
{
    [Fact]
    public void Identity_request_and_token_round_trip_and_bad_tokens_are_ignored()
    {
        using var dir = new TempDir();
        var store = new IdentityStore(dir.Path);
        Assert.Null(store.LoadIdentity());
        Assert.Null(store.LoadToken());
        File.WriteAllText(store.TokenPath, "short");
        Assert.Null(store.LoadToken());
        File.WriteAllText(store.TokenPath, "token with spaces and ; semicolons ........");
        Assert.Null(store.LoadToken());
        string token = new('A', 43);
        File.WriteAllText(store.TokenPath, token + "\n");
        Assert.Equal(token, store.LoadToken());
        store.DeleteToken();
        Assert.Null(store.LoadToken());

        var id = Guid.NewGuid();
        store.SaveRequestId(id);
        Assert.Equal(id, store.LoadRequestId());
        store.ClearRequestId();
        Assert.Null(store.LoadRequestId());

        var identity = new AgentIdentity(Guid.NewGuid(), "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n");
        store.SaveIdentity(identity);
        Assert.Equal(identity, store.LoadIdentity());
    }
}

public sealed class PinningTests
{
    private static (X509Certificate2 Ca, ECDsa Key) Ca(string name)
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={name}", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        return (request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1)), key);
    }

    private static X509Certificate2 Server((X509Certificate2 Ca, ECDsa Key) ca, string eku = "1.3.6.1.5.5.7.3.1")
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new(eku) }, false));
        return request.Create(ca.Ca.SubjectName, X509SignatureGenerator.CreateForECDsa(ca.Key), DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30), new byte[] { 1, 2, 3, 4 });
    }

    [Fact]
    public void Only_a_server_certificate_from_the_platform_ca_is_trusted()
    {
        var platform = Ca("Platform CA");
        var other = Ca("Some public CA");
        Assert.True(AgentApiClient.PinnedValidation(platform.Ca, Server(platform), SslPolicyErrors.None));
        Assert.True(AgentApiClient.PinnedValidation(platform.Ca, Server(platform), SslPolicyErrors.RemoteCertificateChainErrors), "chain errors from the OS store do not matter; the pin decides");
        Assert.False(AgentApiClient.PinnedValidation(platform.Ca, Server(other), SslPolicyErrors.None), "a certificate from any other CA is refused");
        Assert.False(AgentApiClient.PinnedValidation(platform.Ca, Server(platform), SslPolicyErrors.RemoteCertificateNameMismatch), "wrong host name");
        Assert.False(AgentApiClient.PinnedValidation(platform.Ca, Server(platform, "1.3.6.1.5.5.7.3.2"), SslPolicyErrors.None), "a client certificate cannot act as the server");
        Assert.False(AgentApiClient.PinnedValidation(platform.Ca, null, SslPolicyErrors.RemoteCertificateNotAvailable));
    }

    [Fact]
    public void The_in_memory_key_store_joins_only_its_own_certificates()
    {
        using var keys = new InMemoryKeyStore();
        string csr = keys.CreateSigningRequestPem();
        Assert.StartsWith("-----BEGIN CERTIFICATE REQUEST-----", csr);
        var platform = Ca("Platform CA");
        var request = CertificateRequest.LoadSigningRequestPem(csr, HashAlgorithmName.SHA256, CertificateRequestLoadOptions.Default, RSASignaturePadding.Pkcs1);
        using var issued = request.Create(platform.Ca.SubjectName, X509SignatureGenerator.CreateForECDsa(platform.Key), DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30), new byte[] { 9, 9 });
        using var joined = keys.WithPrivateKey(issued.ExportCertificatePem());
        Assert.True(joined.HasPrivateKey);
        using var stranger = new InMemoryKeyStore();
        Assert.ThrowsAny<Exception>(() => stranger.WithPrivateKey(issued.ExportCertificatePem()));
    }
}

public sealed class ConnectionFailureTests
{
    private sealed class BrokenKeyStore : IAgentKeyStore
    {
        public int Calls;
        public string CreateSigningRequestPem() { Calls++; throw new System.Security.Cryptography.CryptographicException("Access is denied."); }
        public X509Certificate2 WithPrivateKey(string certificatePem) => throw new NotSupportedException();
    }

    [Fact]
    public async Task An_unexpected_failure_is_logged_and_retried_not_swallowed()
    {
        using var dir = new TempDir();
        var store = new IdentityStore(dir.Path);
        File.WriteAllText(store.TokenPath, new string('A', 43));
        var keys = new BrokenKeyStore();
        var log = new List<string>();
        using var ca = X509Certificate2.CreateFromPem(CertificateRequestPem());
        var connection = new AgentConnection(new AgentConnectionOptions
        {
            ServerUri = new Uri("https://localhost:1"), PlatformCa = ca, Keys = keys, Store = store, Config = Fixtures.Config(),
            ProcessorFor = _ => throw new NotSupportedException(), Fingerprints = () => throw new NotSupportedException(),
            AgentVersion = "0.2.0", UptimeSeconds = () => 1, Log = m => { lock (log) log.Add(m); },
            Backoff = new Backoff(TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(20)),
            LoopRestartBackoff = () => new Backoff(TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(20)),
        });
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await connection.RunAsync(stop.Token);
        lock (log) Assert.Contains(log, m => m.Contains("CryptographicException") && m.Contains("retrying"));
        Assert.True(keys.Calls >= 2, "it tried again");
    }

    private static string CertificateRequestPem()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var ca = new CertificateRequest("CN=CA", key, HashAlgorithmName.SHA256).CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        return ca.ExportCertificatePem();
    }
}
