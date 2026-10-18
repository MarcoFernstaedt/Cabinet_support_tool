using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

/// <summary>
/// The real connection loops against a scripted server (protocol 1.1): leased delivery, durable results,
/// the worker, pacing, event batching and set-aside, renewal and loop restarts.
/// </summary>
public sealed class ConnectionLoopTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly InMemoryKeyStore _keys = new();
    private readonly ECDsa _caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly X509Certificate2 _ca;
    private readonly List<string> _log = new();
    private readonly ManualClock _clock = new(Fixtures.Start);
    private int _runs;

    public ConnectionLoopTests()
    {
        var request = new CertificateRequest("CN=Platform CA", _caKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        _ca = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
    }

    public void Dispose()
    {
        _keys.Dispose();
        _caKey.Dispose();
        _dir.Dispose();
    }

    private string Issue(TimeSpan validFor)
    {
        var csr = CertificateRequest.LoadSigningRequestPem(_keys.CreateSigningRequestPem(), HashAlgorithmName.SHA256, CertificateRequestLoadOptions.Default, RSASignaturePadding.Pkcs1);
        var request = new CertificateRequest(new X500DistinguishedName($"CN={Fixtures.Cabinet:D}"), csr.PublicKey, HashAlgorithmName.SHA256);
        using var issued = request.Create(_ca.SubjectName, X509SignatureGenerator.CreateForECDsa(_caKey), DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow + validFor, RandomNumberGenerator.GetBytes(8));
        return issued.ExportCertificatePem();
    }

    private bool Logged(string text) { lock (_log) return _log.Any(l => l.Contains(text)); }

    private AgentConnection Connection(FakeServer server, EventQueue? events = null, Func<HealthSample?>? health = null, TimeSpan? validFor = null)
    {
        var store = new IdentityStore(_dir.Path);
        store.SaveIdentity(new AgentIdentity(Fixtures.Cabinet, Issue(validFor ?? TimeSpan.FromDays(365))));
        var registry = new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo, async (_, t) =>
        {
            Interlocked.Increment(ref _runs);
            await Task.Delay(OperationDelay, t);
            return new SystemInfoOutput { Hostname = "CAB-1", OsVersion = "10", OsBuild = "1", UptimeSeconds = 1, AgentVersion = "0.2.0", ReadOnlyMode = false, CabinetRole = null, SerialNumber = null };
        });
        var processor = new CommandProcessor(new CommandValidator(Fixtures.Config(), new ReplayStore(null, _clock), new RateLimiter(null, _clock), _clock), registry, _clock);
        return new AgentConnection(new AgentConnectionOptions
        {
            ServerUri = new Uri("https://platform.test:8443"), PlatformCa = _ca, Keys = _keys, Store = store, Config = Fixtures.Config(),
            ProcessorFor = _ => processor, Fingerprints = () => throw new NotSupportedException(), AgentVersion = "0.2.0", UptimeSeconds = () => 1,
            Log = m => { lock (_log) _log.Add(m); }, Events = events, Health = health, HandlerFactory = server.Handler,
            EventSendInterval = TimeSpan.FromMilliseconds(50), HeartbeatInterval = TimeSpan.FromMilliseconds(300), HeartbeatInterval11 = TimeSpan.FromMilliseconds(300),
            MinHeartbeat = TimeSpan.FromMilliseconds(300), MaxHeartbeat = TimeSpan.FromMilliseconds(300), ReconnectFlushJitter = TimeSpan.Zero,
            ResetJitter = TimeSpan.FromMilliseconds(50), Backoff = new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(200)),
            LoopRestartBackoff = () => new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(100)), MaxEventFailures = 3,
            LocalBackoff = () => new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(200)),
        });
    }

    private TimeSpan OperationDelay { get; set; } = TimeSpan.Zero;

    private static async Task Until(Func<bool> condition, string what, int seconds = 15)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Timed out waiting for {what}.");
            await Task.Delay(20);
        }
    }

    private static async Task Run(AgentConnection connection, Func<CancellationToken, Task> test)
    {
        using var stop = new CancellationTokenSource();
        Task running = connection.RunAsync(stop.Token);
        try { await test(stop.Token); }
        finally
        {
            stop.Cancel();
            await running.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }

    private static List<Guid> Acked(SeenRequest r) =>
        r.Query.StartsWith("?ack=", StringComparison.Ordinal) ? r.Query[5..].Split(',').Select(Guid.Parse).ToList() : [];

    [Fact]
    public async Task A_command_is_acknowledged_on_the_next_poll_and_a_repeat_is_answered_from_the_store_not_refused_as_replayed()
    {
        var command = Fixtures.Command();
        Guid id = Guid.Parse(command["commandId"]!.GetValue<string>());
        var server = new FakeServer();
        int polls = 0;
        server.Commands = async (_, t) =>
        {
            int n = Interlocked.Increment(ref polls);
            await Task.Delay(50, t);
            // Offered on the first poll, and again later as if the lease had run out (the poll's answer was lost).
            return n is 1 or 4 ? FakeServer.CommandsAnswer(command) : FakeServer.CommandsAnswer();
        };
        int posted = 0;
        server.Results = (_, _) => Task.FromResult(Interlocked.Increment(ref posted) == 1 ? FakeServer.Ack() : FakeServer.Status(HttpStatusCode.Conflict));
        await Run(Connection(server), async _ =>
        {
            await Until(() => Volatile.Read(ref polls) >= 6 && Volatile.Read(ref posted) >= 2, "the repeat to be answered");
        });
        var polled = server.To("/agent/v1/commands").ToList();
        Assert.Contains(polled, p => Acked(p).Contains(id));
        Assert.Equal(1, _runs);
        var results = server.To("/agent/v1/results").ToList();
        Assert.All(results, r => Assert.Equal("succeeded", r.Json!["status"]!.GetValue<string>()));
        Assert.All(results, r => Assert.Equal(id.ToString(), r.Json!["commandId"]!.GetValue<string>()));
        Assert.True(Logged("offered again; answering with its stored result"));
    }

    [Fact]
    public async Task Polling_goes_on_during_a_long_command_and_a_repeat_while_it_runs_is_ignored()
    {
        OperationDelay = TimeSpan.FromSeconds(3);
        var command = Fixtures.Command();
        var server = new FakeServer();
        int polls = 0;
        server.Commands = async (_, t) =>
        {
            int n = Interlocked.Increment(ref polls);
            await Task.Delay(50, t);
            return n <= 3 ? FakeServer.CommandsAnswer(command) : FakeServer.CommandsAnswer(); // offered three times while it runs
        };
        await Run(Connection(server), async _ =>
        {
            await Until(() => Volatile.Read(ref _runs) == 1, "the command to start");
            int before = Volatile.Read(ref polls);
            await Task.Delay(TimeSpan.FromSeconds(2.2));
            Assert.True(Volatile.Read(ref polls) >= before + 2, "the poll loop is not blocked by the running command");
            await Until(() => server.To("/agent/v1/results").Any(), "the result");
        });
        Assert.Equal(1, _runs);
        Assert.Single(server.To("/agent/v1/results"));
    }

    [Fact]
    public async Task A_result_is_posted_until_accepted_and_survives_a_restart()
    {
        var command = Fixtures.Command();
        var server = new FakeServer();
        bool offered = false;
        server.Commands = async (_, t) =>
        {
            await Task.Delay(50, t);
            if (offered) return FakeServer.CommandsAnswer();
            offered = true;
            return FakeServer.CommandsAnswer(command);
        };
        server.Results = (_, _) => Task.FromResult(FakeServer.Status(HttpStatusCode.InternalServerError));
        await Run(Connection(server), async _ => await Until(() => server.To("/agent/v1/results").Count() >= 2, "retries"));
        Assert.Single(Directory.GetFiles(Path.Combine(_dir.Path, "results", "pending")));

        // Restarted: the stored result is sent, and a 409 (already stored) also counts as delivered.
        var restarted = new FakeServer { Results = (_, _) => Task.FromResult(FakeServer.Status(HttpStatusCode.Conflict)) };
        await Run(Connection(restarted), async _ => await Until(() => !Directory.GetFiles(Path.Combine(_dir.Path, "results", "pending")).Any(), "delivery"));
        Assert.Equal(command["commandId"]!.GetValue<string>(), restarted.To("/agent/v1/results").First().Json!["commandId"]!.GetValue<string>());
        Assert.Equal(1, _runs);
    }

    [Fact]
    public async Task Hostile_poll_answers_do_not_stop_the_agent()
    {
        var server = new FakeServer();
        int polls = 0;
        server.Commands = async (_, t) =>
        {
            await Task.Delay(20, t);
            return (Interlocked.Increment(ref polls) % 4) switch
            {
                0 => FakeServer.Json("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"shell":"cmd"}"""),
                1 => FakeServer.Json("\u0000\u0001garbage"),
                2 => FakeServer.Json("""{"serverTime":"2026-10-17T12:00:00Z","commands":[{"commandId":"not-a-guid"}, 7, "x"]}"""),
                _ => FakeServer.Status(HttpStatusCode.InternalServerError),
            };
        };
        await Run(Connection(server), async _ => await Until(() => Volatile.Read(ref polls) >= 8 && server.To("/agent/v1/heartbeat").Count() >= 2, "more polls"));
        Assert.Equal(0, _runs);
        Assert.Empty(server.To("/agent/v1/results"));
    }

    [Fact]
    public async Task Reconnect_after_ms_holds_the_next_request()
    {
        var server = new FakeServer();
        var times = new List<DateTime>();
        server.Commands = (_, _) =>
        {
            lock (times) times.Add(DateTime.UtcNow);
            return Task.FromResult(times.Count == 1
                ? FakeServer.Json($$"""{"serverTime":"{{FakeServer.ServerTime}}","commands":[],"reconnectAfterMs":1500}""")
                : FakeServer.CommandsAnswer());
        };
        await Run(Connection(server), async _ => await Until(() => { lock (times) return times.Count >= 2; }, "the second poll"));
        lock (times) Assert.True(times[1] - times[0] >= TimeSpan.FromMilliseconds(1400), $"{times[1] - times[0]}");
        Assert.True(Logged("asked the agent to reconnect"));
    }

    [Fact]
    public async Task Server_pacing_is_applied_and_turns_on_gzip()
    {
        var server = new FakeServer
        {
            Heartbeat = (_, _) => Task.FromResult(FakeServer.Json($$$"""{"serverTime":"{{{FakeServer.ServerTime}}}","scanner":{"hardwareIds":null},"intervals":{"heartbeatSeconds":900,"pollSeconds":110,"eventsPaceMs":200}}""")),
        };
        var events = new EventQueue(null);
        AgentConnection connection = Connection(server, events);
        await Run(connection, async _ =>
        {
            await Until(() => connection.Pacing.Server11, "1.1 pacing");
            for (int i = 0; i < 30; i++)
                events.Enqueue(new AgentEvent { EventId = Guid.NewGuid(), Kind = EventKind.SmartWarning, OccurredAt = Fixtures.Start, SeverityHint = SeverityHint.Minor, Detail = new EventDetail { Message = new string('x', 200) } });
            await Until(() => events.Count == 0, "the events");
        });
        Assert.Equal(110, connection.Pacing.PollSeconds);
        Assert.Equal(TimeSpan.FromMilliseconds(200), connection.Pacing.EventsPace);
        Assert.Equal(TimeSpan.FromMilliseconds(300), connection.Pacing.Heartbeat); // this test's clamp range
        Assert.Contains(server.To("/agent/v1/events"), r => r.Gzipped);
    }

    private static AgentEvent Smart(string message = "m") => new()
    {
        EventId = Guid.NewGuid(), Kind = EventKind.SmartWarning, OccurredAt = Fixtures.Start, SeverityHint = SeverityHint.Minor, Detail = new EventDetail { Message = message },
    };

    [Fact]
    public async Task A_413_halves_the_batch()
    {
        var events = new EventQueue(null);
        for (int i = 0; i < 100; i++) events.Enqueue(Smart());
        var server = new FakeServer();
        server.Events = (r, _) => Task.FromResult(r.Json!["events"]!.AsArray().Count > 25 ? FakeServer.Status(HttpStatusCode.RequestEntityTooLarge) : FakeServer.Ack());
        await Run(Connection(server, events), async _ => await Until(() => events.Count == 0, "the queue to drain"));
        var sizes = server.To("/agent/v1/events").Select(r => r.Json!["events"]!.AsArray().Count).ToList();
        Assert.Equal(new[] { 100, 50, 25 }, sizes.Take(3));
    }

    [Fact]
    public async Task One_event_the_server_keeps_refusing_is_set_aside_and_reported_and_the_rest_get_through()
    {
        var events = new EventQueue(_dir.File("events.jsonl"));
        var good = Enumerable.Range(0, 20).Select(_ => Smart()).ToList();
        AgentEvent poison = Smart("poison");
        foreach (var e in good.Take(7)) events.Enqueue(e);
        events.Enqueue(poison);
        foreach (var e in good.Skip(7)) events.Enqueue(e);
        var server = new FakeServer();
        var accepted = new HashSet<string>();
        server.Events = (r, _) =>
        {
            var batch = r.Json!["events"]!.AsArray();
            if (batch.Any(e => e!["detail"]!["message"]?.GetValue<string>() == "poison")) return Task.FromResult(FakeServer.Status(HttpStatusCode.BadRequest));
            lock (accepted) foreach (var e in batch) accepted.Add(e!["eventId"]!.GetValue<string>());
            return Task.FromResult(FakeServer.Ack());
        };
        await Run(Connection(server, events), async _ =>
            await Until(() => { lock (accepted) return good.All(g => accepted.Contains(g.EventId.ToString())) && events.Count == 0; }, "every good event and the report", 30));
        Assert.Equal(1, events.SetAside);
        Assert.Contains(server.To("/agent/v1/events").SelectMany(r => r.Json!["events"]!.AsArray()),
            e => e!["kind"]!.GetValue<string>() == "agent_status" && e["detail"]!["fields"]!["setAsideEvents"]!.GetValue<string>() == "1");
        Assert.Contains("poison", File.ReadAllText(_dir.File("events.jsonl") + ".set-aside.jsonl"));
    }

    [Fact]
    public async Task A_quota_answer_waits_only_the_event_loop()
    {
        var events = new EventQueue(null);
        events.Enqueue(Smart());
        var server = new FakeServer { Events = (_, _) => Task.FromResult(FakeServer.Status(HttpStatusCode.TooManyRequests, TimeSpan.FromSeconds(30))) };
        int polls = 0;
        server.Commands = async (_, t) => { Interlocked.Increment(ref polls); await Task.Delay(50, t); return FakeServer.CommandsAnswer(); };
        await Run(Connection(server, events), async _ =>
        {
            await Until(() => server.To("/agent/v1/events").Any(), "the first send");
            int before = Volatile.Read(ref polls);
            await Task.Delay(TimeSpan.FromSeconds(2.5));
            Assert.Single(server.To("/agent/v1/events")); // Retry-After honoured
            Assert.True(Volatile.Read(ref polls) > before, "polling is not held by an events quota");
        });
    }

    [Fact]
    public async Task Loops_wait_for_the_shared_connection_and_resume_together()
    {
        var server = new FakeServer();
        bool down = true;
        server.Heartbeat = (_, _) => Task.FromResult(Volatile.Read(ref down) ? FakeServer.Status(HttpStatusCode.ServiceUnavailable) : FakeServer.Json($$$"""{"serverTime":"{{{FakeServer.ServerTime}}}","scanner":{"hardwareIds":null}}"""));
        server.Commands = async (_, t) =>
        {
            await Task.Delay(20, t);
            return Volatile.Read(ref down) ? FakeServer.Status(HttpStatusCode.ServiceUnavailable) : FakeServer.CommandsAnswer();
        };
        var events = new EventQueue(null);
        events.Enqueue(Smart());
        await Run(Connection(server, events), async _ =>
        {
            await Task.Delay(1500);
            Assert.Empty(server.To("/agent/v1/events")); // the event sender never probes a server that is down
            Volatile.Write(ref down, false);
            await Until(() => events.Count == 0, "the event after reconnection");
        });
        Assert.True(Logged("Connected to the platform server."));
    }

    [Fact]
    public async Task A_fault_in_one_loop_restarts_that_loop_only()
    {
        var server = new FakeServer();
        int calls = 0;
        AgentConnection connection = Connection(server, health: () => Interlocked.Increment(ref calls) == 2 ? throw new InvalidOperationException("sensor bug") : null);
        await Run(connection, async _ => await Until(() => server.To("/agent/v1/heartbeat").Count() >= 3, "heartbeats after the fault"));
        Assert.True(Logged("The heartbeat loop failed (InvalidOperationException: sensor bug); restarting it"));
        lock (_log) Assert.Single(_log, l => l.Contains("Connected to the platform server."));
        Assert.Equal(1, server.HandlersCreated); // the connection itself was not rebuilt
    }

    [Fact]
    public async Task Renewal_swaps_the_certificate_without_cancelling_running_work()
    {
        OperationDelay = TimeSpan.FromSeconds(1.5);
        var command = Fixtures.Command();
        var server = new FakeServer();
        bool offered = false;
        server.Commands = async (_, t) =>
        {
            await Task.Delay(50, t);
            if (offered) return FakeServer.CommandsAnswer();
            offered = true;
            return FakeServer.CommandsAnswer(command);
        };
        var renewed = new TaskCompletionSource();
        server.Renew = async (_, t) =>
        {
            await Task.Delay(300, t); // while the command runs
            renewed.TrySetResult();
            return FakeServer.Json(new JsonObject { ["certificate"] = Issue(TimeSpan.FromDays(365)), ["caChain"] = _ca.ExportCertificatePem(), ["serverTime"] = FakeServer.ServerTime }.ToJsonString());
        };
        await Run(Connection(server, validFor: TimeSpan.FromDays(5)), async _ =>
        {
            await renewed.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await Until(() => server.To("/agent/v1/results").Any(), "the command's result");
            await Until(() => server.Requests.Any(r => r.HandlerNumber == 2), "a request on the new certificate");
        });
        Assert.Equal("succeeded", server.To("/agent/v1/results").First().Json!["status"]!.GetValue<string>());
        Assert.True(Logged("Renewed the cabinet's certificate; new connections use it."));
        lock (_log) Assert.Single(_log, l => l.Contains("Connected to the platform server."));
        Assert.Equal(1, _runs);
    }
}
