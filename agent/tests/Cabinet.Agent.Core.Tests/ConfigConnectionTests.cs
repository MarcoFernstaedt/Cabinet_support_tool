using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Configuration;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

/// <summary>The configuration sender of the real connection, against a scripted server: delivery, a quota, load shedding, a refusal, and the server being away.</summary>
public sealed class ConfigConnectionTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly InMemoryKeyStore _keys = new();
    private readonly ECDsa _caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly X509Certificate2 _ca;
    private readonly List<string> _log = new();

    public ConfigConnectionTests()
    {
        var request = new CertificateRequest("CN=Platform CA", _caKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        _ca = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
    }

    public void Dispose() { _keys.Dispose(); _caKey.Dispose(); _dir.Dispose(); }

    private AgentConnection Connection(FakeServer server, ConfigQueue queue)
    {
        var store = new IdentityStore(_dir.Path);
        var csr = CertificateRequest.LoadSigningRequestPem(_keys.CreateSigningRequestPem(), HashAlgorithmName.SHA256, CertificateRequestLoadOptions.Default, RSASignaturePadding.Pkcs1);
        var req = new CertificateRequest(new X500DistinguishedName($"CN={Fixtures.Cabinet:D}"), csr.PublicKey, HashAlgorithmName.SHA256);
        using var issued = req.Create(_ca.SubjectName, X509SignatureGenerator.CreateForECDsa(_caKey), DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(365), RandomNumberGenerator.GetBytes(8));
        store.SaveIdentity(new AgentIdentity(Fixtures.Cabinet, issued.ExportCertificatePem()));
        var clock = new ManualClock(Fixtures.Start);
        var processor = new CommandProcessor(new CommandValidator(Fixtures.Config(), new ReplayStore(null, clock), new RateLimiter(null, clock), clock), new OperationRegistry(), clock);
        return new AgentConnection(new AgentConnectionOptions
        {
            ServerUri = new Uri("https://platform.test:8443"), PlatformCa = _ca, Keys = _keys, Store = store, Config = Fixtures.Config(),
            ProcessorFor = _ => processor, Fingerprints = () => throw new NotSupportedException(), AgentVersion = "0.2.0", UptimeSeconds = () => 1,
            Log = m => { lock (_log) _log.Add(m); }, HandlerFactory = server.Handler, ConfigUploads = queue, ConfigSendInterval = TimeSpan.FromMilliseconds(30),
            HeartbeatInterval = TimeSpan.FromMilliseconds(300), HeartbeatInterval11 = TimeSpan.FromMilliseconds(300), MinHeartbeat = TimeSpan.FromMilliseconds(300), MaxHeartbeat = TimeSpan.FromMilliseconds(300),
            ResetJitter = TimeSpan.FromMilliseconds(50), Backoff = new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(200)),
            LoopRestartBackoff = () => new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(100)), LocalBackoff = () => new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(200)),
        });
    }

    private static ConfigUploadSnapshot Snapshot(int n, ConfigCategory category = ConfigCategory.Services)
    {
        var c = ConfigBuilders.Make(category, [new ConfigItem { Key = category == ConfigCategory.Time ? "time" : "service:x", Values = new Dictionary<string, object?> { ["v"] = "value " + n } }]);
        return new ConfigUploadSnapshot { ObservedAt = Fixtures.Start.AddMinutes(n), Category = c.Category, Hash = c.Hash, Truncated = false, Items = c.Items };
    }

    private async Task Run(AgentConnection connection, Func<Task> body)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task running = connection.RunAsync(cts.Token);
        try { await body(); } finally { cts.Cancel(); try { await running; } catch (OperationCanceledException) { } }
    }

    private static async Task Until(Func<bool> condition, string what, int seconds = 15)
    {
        for (var end = DateTime.UtcNow.AddSeconds(seconds); !condition(); await Task.Delay(20))
            if (DateTime.UtcNow > end) throw new TimeoutException($"Timed out waiting for {what}.");
    }

    [Fact]
    public async Task Queued_snapshots_reach_the_server_oldest_first_exactly_as_checked_and_then_the_queue_is_empty()
    {
        var server = new FakeServer();
        var queue = new ConfigQueue(null);
        for (int i = 0; i < 3; i++) Assert.True(queue.Enqueue(Snapshot(i)));
        await Run(Connection(server, queue), async () =>
        {
            await Until(() => queue.Count == 0, "the queue to drain");
            var sent = server.To("/agent/v1/config").ToList();
            Assert.Single(sent);
            Assert.Equal([Fixtures.Start, Fixtures.Start.AddMinutes(1), Fixtures.Start.AddMinutes(2)], sent[0].Json!["snapshots"]!.AsArray().Select(s => s!["observedAt"]!.GetValue<DateTimeOffset>()));
            using var doc = JsonDocument.Parse(sent[0].Body);
            Assert.True(ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("config-upload"), doc.RootElement));
        });
    }

    [Fact]
    public async Task A_quota_and_load_shedding_make_it_wait_and_try_again_and_lose_nothing()
    {
        int calls = 0;
        var server = new FakeServer
        {
            Config = (_, _) => Task.FromResult(Interlocked.Increment(ref calls) switch
            {
                1 => FakeServer.Status(HttpStatusCode.TooManyRequests, TimeSpan.FromMilliseconds(100)),
                2 => FakeServer.Status(HttpStatusCode.ServiceUnavailable, TimeSpan.FromMilliseconds(100)),
                _ => FakeServer.Ack(),
            }),
        };
        var queue = new ConfigQueue(null);
        queue.Enqueue(Snapshot(1));
        await Run(Connection(server, queue), async () =>
        {
            await Until(() => queue.Count == 0, "the retries to succeed");
            Assert.Equal(3, server.To("/agent/v1/config").Count());
        });
    }

    [Fact]
    public async Task A_snapshot_the_server_refuses_is_dropped_so_it_cannot_block_the_ones_behind_it_and_its_category_is_looked_at_again()
    {
        var server = new FakeServer { Config = (r, _) => Task.FromResult(r.Body.Contains("refuse me") ? FakeServer.Status(HttpStatusCode.BadRequest) : FakeServer.Ack()) };
        var queue = new ConfigQueue(null);
        var discarded = new List<ConfigCategory>();
        queue.Discarded += c => { lock (discarded) discarded.AddRange(c); };
        var bad = ConfigBuilders.Make(ConfigCategory.Time, [new ConfigItem { Key = "time", Values = new Dictionary<string, object?> { ["v"] = "refuse me" } }]);
        queue.Enqueue(new ConfigUploadSnapshot { ObservedAt = Fixtures.Start, Category = bad.Category, Hash = bad.Hash, Truncated = false, Items = bad.Items });
        await Run(Connection(server, queue), async () =>
        {
            await Until(() => queue.Count == 0, "the refused snapshot to be dropped");
            queue.Enqueue(Snapshot(5));
            await Until(() => queue.Count == 0 && server.To("/agent/v1/config").Count() == 2, "the next snapshot to be delivered");
            lock (discarded) Assert.Equal([ConfigCategory.Time], discarded);
            Assert.True(Logged("refused 1 configuration snapshot"));
        });
    }

    [Fact]
    public async Task While_the_server_is_unreachable_nothing_is_dropped_and_everything_arrives_when_it_returns()
    {
        bool up = false;
        var server = new FakeServer { Config = (_, _) => up ? Task.FromResult(FakeServer.Ack()) : throw new HttpRequestException("down") };
        var queue = new ConfigQueue(null);
        for (int i = 0; i < 4; i++) queue.Enqueue(Snapshot(i, i % 2 == 0 ? ConfigCategory.Services : ConfigCategory.Time));
        await Run(Connection(server, queue), async () =>
        {
            await Task.Delay(800);
            Assert.Equal(4, queue.Count);
            up = true;
            await Until(() => queue.Count == 0, "the queue to drain after the server returned");
            Assert.Equal(0, queue.Dropped);
        });
    }

    private bool Logged(string text) { lock (_log) return _log.Any(l => l.Contains(text)); }
}
