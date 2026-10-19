using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

public sealed class ConnectivityTests
{
    private static AgentApiException Network() => new(null, "unreachable", "cut");
    private static AgentApiException Status(HttpStatusCode status, TimeSpan? retryAfter = null) => new(status, "error", "refused", retryAfter);

    private static async Task<TimeSpan> Timed(Func<Task> action)
    {
        var watch = Stopwatch.StartNew();
        await action();
        return watch.Elapsed;
    }

    [Theory]
    [InlineData(null, FailureKind.Network)]
    [InlineData(HttpStatusCode.ServiceUnavailable, FailureKind.Unavailable)]
    [InlineData(HttpStatusCode.BadGateway, FailureKind.Unavailable)]
    [InlineData(HttpStatusCode.GatewayTimeout, FailureKind.Unavailable)]
    [InlineData(HttpStatusCode.TooManyRequests, FailureKind.Quota)]
    [InlineData(HttpStatusCode.Unauthorized, FailureKind.CertificateRefused)]
    [InlineData(HttpStatusCode.BadRequest, FailureKind.Answered)]
    [InlineData(HttpStatusCode.InternalServerError, FailureKind.Answered)]
    [InlineData(HttpStatusCode.OK, FailureKind.Answered)] // a malformed 200 answer: the server was reached
    public void Failures_are_classified_by_what_they_say_about_the_connection(HttpStatusCode? status, FailureKind kind) =>
        Assert.Equal(kind, Connectivity.Classify(new AgentApiException(status, "x", "y")));

    [Fact]
    public async Task A_reset_of_a_held_connection_waits_a_random_short_time_not_the_backoff()
    {
        var link = new Connectivity(new Backoff(TimeSpan.FromMinutes(1)), resetJitter: TimeSpan.FromMilliseconds(200));
        link.Reached();
        link.Failed(Network());
        Assert.False(link.IsConnected);
        TimeSpan took = await Timed(async () => { using var _ = await link.EnterAsync(new CancellationTokenSource(5000).Token); });
        Assert.True(took < TimeSpan.FromSeconds(2), $"{took}");
    }

    [Theory]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    public async Task A_shed_answer_with_retry_after_leaves_the_shared_state_alone(HttpStatusCode status)
    {
        // The server answered, so it was reached: the other loops (the long poll above all) must not wait for the endpoint that was told to.
        var link = new Connectivity(new Backoff(TimeSpan.FromMinutes(5)));
        link.Reached();
        link.Failed(Status(status, TimeSpan.FromSeconds(90)));
        Assert.True(link.IsConnected);
        TimeSpan took = await Timed(async () => { using var _ = await link.EnterAsync(CancellationToken.None); });
        Assert.True(took < TimeSpan.FromMilliseconds(500), $"{took}");
        // Also as the very first answer after a loss: a 503 proves the server is back.
        var down = new Connectivity(new Backoff(TimeSpan.FromMinutes(5)));
        down.Failed(Network());
        Assert.False(down.IsConnected);
        down.Failed(Status(status, TimeSpan.FromSeconds(90)));
        Assert.True(down.IsConnected);
    }

    [Fact]
    public async Task A_network_failure_still_pauses_every_loop_for_the_backoff_and_a_server_wait_is_honoured()
    {
        var link = new Connectivity(new Backoff(TimeSpan.FromMilliseconds(600), TimeSpan.FromMilliseconds(600)));
        link.Failed(Network());
        Assert.False(link.IsConnected);
        TimeSpan took = await Timed(async () => { using var _ = await link.EnterAsync(CancellationToken.None); });
        Assert.True(took >= TimeSpan.FromMilliseconds(500), $"{took}");
        var withWait = new Connectivity(new Backoff(TimeSpan.FromMilliseconds(5), TimeSpan.FromMilliseconds(10)));
        withWait.Failed(new AgentApiException(null, "unreachable", "cut", TimeSpan.FromMilliseconds(800)));
        took = await Timed(async () => { using var _ = await withWait.EnterAsync(CancellationToken.None); });
        Assert.True(took >= TimeSpan.FromMilliseconds(700), $"{took}");
    }

    [Theory]
    [InlineData(30, 30)]
    [InlineData(1, 1)]
    [InlineData(31_536_000, 600)]       // a year: capped at the 10-minute maximum
    [InlineData(null, 0)]               // none: the endpoint's own backoff alone
    public void An_endpoint_waits_at_least_its_retry_after_and_never_longer_than_the_maximum(int? seconds, int atLeast)
    {
        var e = new AgentApiException(HttpStatusCode.ServiceUnavailable, "busy", "shed", seconds is { } s ? TimeSpan.FromSeconds(s) : null);
        TimeSpan wait = AgentConnection.LocalWait(e, new Backoff(TimeSpan.FromMilliseconds(5), TimeSpan.FromMilliseconds(10)));
        Assert.True(wait >= TimeSpan.FromSeconds(atLeast), $"{wait}");
        Assert.True(wait <= Connectivity.MaxServerWait, $"{wait}");
        // A hostile (negative) wait is no wait at all.
        var hostile = new AgentApiException(HttpStatusCode.ServiceUnavailable, "busy", "shed", TimeSpan.FromSeconds(-5));
        Assert.True(AgentConnection.LocalWait(hostile, new Backoff(TimeSpan.FromMilliseconds(5), TimeSpan.FromMilliseconds(10))) <= TimeSpan.FromMilliseconds(10));
        // The heartbeat caps its own backoff at its interval, but not the server's Retry-After.
        var capped = AgentConnection.LocalWait(new AgentApiException(HttpStatusCode.ServiceUnavailable, "busy", "shed", TimeSpan.FromSeconds(45)), new Backoff(TimeSpan.FromMinutes(5)), TimeSpan.FromSeconds(1));
        Assert.Equal(TimeSpan.FromSeconds(45), capped);
    }

    [Fact]
    public async Task The_server_asking_to_reconnect_later_holds_every_loop()
    {
        var link = new Connectivity(new Backoff(TimeSpan.FromMilliseconds(5), TimeSpan.FromMilliseconds(10)));
        link.Reached();
        link.ServerAskedToWait(TimeSpan.FromMilliseconds(600));
        TimeSpan took = await Timed(async () => { using var _ = await link.EnterAsync(CancellationToken.None); });
        Assert.True(took >= TimeSpan.FromMilliseconds(500), $"{took}");
    }

    [Fact]
    public async Task A_hostile_wait_is_capped()
    {
        var link = new Connectivity(new Backoff(TimeSpan.FromMilliseconds(5)));
        link.Failed(new AgentApiException(null, "unreachable", "cut", TimeSpan.FromDays(365)));
        link.ServerAskedToWait(TimeSpan.FromDays(365));
        using var cts = new CancellationTokenSource(200);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => link.EnterAsync(cts.Token));
        Assert.Equal(TimeSpan.FromMinutes(10), Connectivity.MaxServerWait);
    }

    [Fact]
    public async Task One_probe_at_a_time_and_the_other_loops_wait_for_connected()
    {
        var link = new Connectivity(new Backoff(TimeSpan.FromMilliseconds(5), TimeSpan.FromMilliseconds(10)));
        link.Failed(Network());
        var first = await link.EnterAsync(CancellationToken.None);
        Assert.True(first.IsProbe);
        Task<Connectivity.Lease> second = link.EnterAsync(CancellationToken.None);
        Task<Connectivity.Lease> sender = link.EnterAsync(CancellationToken.None, probe: false);
        await Task.Delay(150);
        Assert.False(second.IsCompleted, "a second probe waits while one is out");
        Assert.False(sender.IsCompleted);
        link.Failed(Network());
        first.Dispose();
        using (Connectivity.Lease next = await second.WaitAsync(TimeSpan.FromSeconds(5))) Assert.True(next.IsProbe);
        await Task.Delay(100);
        Assert.False(sender.IsCompleted, "a non-probing loop waits for connected");
        link.Reached();
        using (await sender.WaitAsync(TimeSpan.FromSeconds(5))) { }
        await link.WaitConnectedAsync(CancellationToken.None);
    }

    [Fact]
    public async Task The_heartbeat_caps_the_backoff_at_its_interval()
    {
        var link = new Connectivity(new Backoff(TimeSpan.FromMinutes(5)));
        link.Failed(Network());
        TimeSpan took = await Timed(async () => { using var _ = await link.EnterAsync(CancellationToken.None, maxBackoff: TimeSpan.FromMilliseconds(200)); });
        Assert.True(took < TimeSpan.FromSeconds(2), $"{took}");
    }

    [Fact]
    public async Task A_network_change_cuts_the_backoff_short_with_jitter()
    {
        var link = new Connectivity(new Backoff(TimeSpan.FromMinutes(5)), networkChangeJitter: TimeSpan.FromMilliseconds(100));
        link.Failed(Network());
        Task<Connectivity.Lease> waiting = link.EnterAsync(CancellationToken.None);
        await Task.Delay(100);
        Assert.False(waiting.IsCompleted);
        link.NetworkChanged();
        using (await waiting.WaitAsync(TimeSpan.FromSeconds(5))) { }
    }

    [Fact]
    public void Quotas_sheds_and_refusals_do_not_mark_the_server_down_but_a_network_failure_does()
    {
        var link = new Connectivity();
        link.Reached();
        Assert.Equal(FailureKind.Quota, link.Failed(Status(HttpStatusCode.TooManyRequests, TimeSpan.FromSeconds(30))));
        Assert.Equal(FailureKind.Answered, link.Failed(Status(HttpStatusCode.BadRequest)));
        Assert.True(link.IsConnected);
        Assert.Equal(FailureKind.Unavailable, link.Failed(Status(HttpStatusCode.ServiceUnavailable)));
        Assert.True(link.IsConnected, "a shed answer proves the server was reached; only the endpoint waits");
        Assert.Equal(FailureKind.Network, link.Failed(Network()));
        Assert.False(link.IsConnected);
    }

    [Fact]
    public void Reconnection_is_reported_once_per_loss()
    {
        var link = new Connectivity();
        var seen = new List<bool>();
        var lost = 0;
        link.Connected += r => seen.Add(r);
        link.Lost += _ => lost++;
        link.Reached();
        link.Reached();
        link.Failed(Network());
        link.Failed(Network());
        link.Reached();
        Assert.Equal(new[] { false, true }, seen);
        Assert.Equal(1, lost);
    }
}

public sealed class PacingTests
{
    private static Pacing Default() => new(TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(300), TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(900));

    [Fact]
    public void A_server_that_sends_no_pacing_keeps_the_1_0_timing()
    {
        Pacing p = Default();
        p.Apply(null);
        p.ApplyPoll(null);
        Assert.False(p.Server11);
        Assert.Equal(TimeSpan.FromSeconds(60), p.Heartbeat);
        Assert.Equal(25, p.PollSeconds);
        Assert.Equal(TimeSpan.Zero, p.EventsPace);
    }

    [Fact]
    public void A_1_1_server_moves_the_heartbeat_to_300_s_unless_it_names_one()
    {
        Pacing p = Default();
        p.Apply(new ServerIntervals());
        Assert.True(p.Server11);
        Assert.Equal(TimeSpan.FromSeconds(300), p.Heartbeat);
        p.Apply(new ServerIntervals { HeartbeatSeconds = 120, PollSeconds = 90, EventsPaceMs = 250 });
        Assert.Equal(TimeSpan.FromSeconds(120), p.Heartbeat);
        Assert.Equal(90, p.PollSeconds);
        Assert.Equal(TimeSpan.FromMilliseconds(250), p.EventsPace);
    }

    [Theory]
    [InlineData(1, 1, -5, 60, 15, 0)]
    [InlineData(int.MaxValue, int.MaxValue, int.MaxValue, 900, 110, 60000)]
    [InlineData(int.MinValue, int.MinValue, int.MinValue, 60, 15, 0)]
    public void Out_of_range_values_are_clamped(int heartbeat, int poll, int pace, int heartbeatOut, int pollOut, int paceOut)
    {
        Pacing p = Default();
        p.Apply(new ServerIntervals { HeartbeatSeconds = heartbeat, PollSeconds = poll, EventsPaceMs = pace });
        Assert.Equal(TimeSpan.FromSeconds(heartbeatOut), p.Heartbeat);
        Assert.Equal(pollOut, p.PollSeconds);
        Assert.Equal(TimeSpan.FromMilliseconds(paceOut), p.EventsPace);
        p.ApplyPoll(-1);
        Assert.Equal(15, p.PollSeconds);
    }
}

public sealed class ApiClientProtocolTests
{
    private static readonly X509Certificate2 Ca = SelfSigned();

    private static X509Certificate2 SelfSigned()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return new CertificateRequest("CN=Test CA", key, HashAlgorithmName.SHA256).CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
    }

    private static AgentApiClient Client(FakeServer server) => new(new Uri("https://platform.test:8443"), Ca, null, server.Handler);

    [Fact]
    public async Task The_poll_acknowledges_at_most_50_commands_and_reads_the_pacing_fields()
    {
        var server = new FakeServer { Commands = (_, _) => Task.FromResult(FakeServer.Json($$"""{"serverTime":"{{FakeServer.ServerTime}}","commands":[],"pollSeconds":90,"reconnectAfterMs":1234}""")) };
        using var api = Client(server);
        var ids = Enumerable.Range(0, 60).Select(_ => Guid.NewGuid()).ToList();
        CommandBatch batch = await api.CommandsAsync(ids, 25, CancellationToken.None);
        Assert.Equal(90, batch.PollSeconds);
        Assert.Equal(1234, batch.ReconnectAfterMs);
        SeenRequest seen = Assert.Single(server.Requests);
        Assert.Equal("?ack=" + string.Join(",", ids.Take(50).Select(i => i.ToString("D"))), seen.Query);
        Assert.Equal(HttpVersion.Version20, seen.Version);
        Assert.Equal(HttpVersionPolicy.RequestVersionOrLower, seen.Policy);

        await api.CommandsAsync([], 25, CancellationToken.None);
        Assert.Equal("", server.Requests.Last().Query);
    }

    [Theory]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"pollSeconds":5000}""")]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"pollSeconds":"25"}""")]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"pollSeconds":25.5}""")]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"reconnectAfterMs":-1}""")]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"reconnectAfterMs":99999999999}""")]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"run":"cmd.exe"}""")]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":{}}""")]
    [InlineData("""{"serverTime":"2026-10-17T12:00:00Z","commands":[],"pollSeconds":25,"pollSeconds":26}""")]
    [InlineData("""{"commands":[]}""")]
    [InlineData("""[]""")]
    [InlineData("""not json""")]
    public async Task Hostile_poll_answers_are_refused_whole(string body)
    {
        var server = new FakeServer { Commands = (_, _) => Task.FromResult(FakeServer.Json(body)) };
        using var api = Client(server);
        var e = await Assert.ThrowsAsync<AgentApiException>(() => api.CommandsAsync([], 25, CancellationToken.None));
        Assert.Equal("malformed_response", e.Code);
    }

    [Fact]
    public async Task More_than_50_commands_is_refused()
    {
        var commands = Enumerable.Range(0, 51).Select(_ => (JsonNode)Fixtures.Command()).ToArray();
        var server = new FakeServer { Commands = (_, _) => Task.FromResult(FakeServer.CommandsAnswer(commands)) };
        using var api = Client(server);
        await Assert.ThrowsAsync<AgentApiException>(() => api.CommandsAsync([], 25, CancellationToken.None));
    }

    [Fact]
    public async Task Retry_after_is_kept_and_clamped()
    {
        var server = new FakeServer { Heartbeat = (_, _) => Task.FromResult(FakeServer.Status(HttpStatusCode.ServiceUnavailable, TimeSpan.FromSeconds(42))) };
        using var api = Client(server);
        var e = await Assert.ThrowsAsync<AgentApiException>(() => api.HeartbeatAsync(Beat(), CancellationToken.None));
        Assert.Equal(TimeSpan.FromSeconds(42), e.RetryAfter);
        server.Heartbeat = (_, _) => Task.FromResult(FakeServer.Status(HttpStatusCode.ServiceUnavailable, TimeSpan.FromDays(400)));
        e = await Assert.ThrowsAsync<AgentApiException>(() => api.HeartbeatAsync(Beat(), CancellationToken.None));
        Assert.Equal(Connectivity.MaxServerWait, e.RetryAfter);
        server.Heartbeat = (_, _) => Task.FromResult(FakeServer.Status(HttpStatusCode.BadRequest));
        e = await Assert.ThrowsAsync<AgentApiException>(() => api.HeartbeatAsync(Beat(), CancellationToken.None));
        Assert.Null(e.RetryAfter);
    }

    private static Heartbeat Beat() => new() { AgentVersion = "0.2.0", UptimeSeconds = 1, ReadOnlyMode = false };

    [Fact]
    public async Task A_heartbeat_answer_with_intervals_is_read()
    {
        var server = new FakeServer
        {
            Heartbeat = (_, _) => Task.FromResult(FakeServer.Json($$$"""{"serverTime":"{{{FakeServer.ServerTime}}}","scanner":{"hardwareIds":null},"intervals":{"heartbeatSeconds":600,"pollSeconds":60,"eventsPaceMs":500}}""")),
        };
        using var api = Client(server);
        HeartbeatResponse answer = await api.HeartbeatAsync(Beat(), CancellationToken.None);
        Assert.Equal(new ServerIntervals { HeartbeatSeconds = 600, PollSeconds = 60, EventsPaceMs = 500 }, answer.Intervals);
        server.Heartbeat = (_, _) => Task.FromResult(FakeServer.Json($$$"""{"serverTime":"{{{FakeServer.ServerTime}}}","scanner":{"hardwareIds":null},"intervals":{"heartbeatSeconds":5}}"""));
        await Assert.ThrowsAsync<AgentApiException>(() => api.HeartbeatAsync(Beat(), CancellationToken.None)); // outside the contract: refused, not used
    }

    private static List<string> Events(int count, int messageLength = 100) => Enumerable.Range(0, count).Select(i => JsonSerializer.Serialize(new AgentEvent
    {
        EventId = Guid.NewGuid(), Kind = EventKind.SmartWarning, OccurredAt = Fixtures.Start, SeverityHint = SeverityHint.Minor,
        Detail = new EventDetail { Message = new string('x', messageLength) },
    }, ContractJson.Options)).ToList();

    [Fact]
    public async Task Events_are_gzipped_only_when_allowed_and_a_415_falls_back_at_once()
    {
        var server = new FakeServer();
        using var api = Client(server);
        await api.PostEventsRawAsync(Events(20), CancellationToken.None);
        Assert.False(server.Requests.Last().Gzipped, "a server not known to speak 1.1 never gets a compressed body");
        api.GzipAllowed = true;
        await api.PostEventsRawAsync(Events(1, 10), CancellationToken.None);
        Assert.False(server.Requests.Last().Gzipped, "small bodies are not compressed");
        await api.PostEventsRawAsync(Events(20), CancellationToken.None);
        SeenRequest gz = server.Requests.Last();
        Assert.True(gz.Gzipped);
        Assert.Equal(20, gz.Json!["events"]!.AsArray().Count);

        server.Events = (r, _) => Task.FromResult(r.Gzipped ? FakeServer.Status(HttpStatusCode.UnsupportedMediaType) : FakeServer.Ack());
        int before = server.Requests.Count;
        await api.PostEventsRawAsync(Events(20), CancellationToken.None);
        Assert.Equal(2, server.Requests.Count - before);
        Assert.False(server.Requests.Last().Gzipped);
        await api.PostEventsRawAsync(Events(20), CancellationToken.None);
        Assert.False(server.Requests.Last().Gzipped, "after a 415, plain bodies for a while");
    }

    [Fact]
    public async Task A_renewed_certificate_is_used_for_new_requests_while_one_in_flight_finishes()
    {
        var release = new TaskCompletionSource();
        var server = new FakeServer();
        server.Commands = async (r, t) =>
        {
            if (r.HandlerNumber == 1) await release.Task.WaitAsync(t);
            return FakeServer.CommandsAnswer();
        };
        using var api = Client(server);
        Task<CommandBatch> held = api.CommandsAsync([], 25, CancellationToken.None);
        await Task.Delay(100);
        api.SwapClientCertificate(SelfSigned());
        await api.CommandsAsync([], 25, CancellationToken.None);
        Assert.Equal(2, server.Requests.Last().HandlerNumber);
        Assert.False(held.IsCompleted);
        release.SetResult();
        await held; // not cancelled by the swap
    }

    [Fact]
    public void The_real_handler_keeps_one_long_lived_connection_with_strict_trust()
    {
        using SocketsHttpHandler h = AgentApiClient.CreateHandler(Ca, null);
        Assert.False(h.UseProxy);
        Assert.False(h.AllowAutoRedirect);
        Assert.Equal(TimeSpan.FromSeconds(20), h.KeepAlivePingDelay);
        Assert.Equal(TimeSpan.FromSeconds(10), h.KeepAlivePingTimeout);
        Assert.Equal(HttpKeepAlivePingPolicy.Always, h.KeepAlivePingPolicy);
        Assert.Equal(TimeSpan.FromSeconds(20), h.PooledConnectionIdleTimeout);
        Assert.InRange(h.PooledConnectionLifetime, TimeSpan.FromHours(23), TimeSpan.FromHours(25));
        Assert.NotNull(h.ConnectCallback);
        Assert.NotNull(h.SslOptions.RemoteCertificateValidationCallback);
        Assert.False(h.SslOptions.RemoteCertificateValidationCallback!(this, null, null, System.Net.Security.SslPolicyErrors.None), "no certificate, no connection");
    }

    [Fact]
    public void Tcp_keepalive_is_set_on_the_socket()
    {
        using var socket = new Socket(SocketType.Stream, ProtocolType.Tcp);
        AgentApiClient.ConfigureKeepAlive(socket);
        Assert.NotEqual(0, (int)socket.GetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive)!);
        Assert.Equal(20, (int)socket.GetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveTime)!);
        Assert.Equal(5, (int)socket.GetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveInterval)!);
    }
}

public sealed class ResultOutboxTests
{
    private static Result Ok(Guid? id = null, int outputChars = 10) => new()
    {
        CommandId = id ?? Guid.NewGuid(), Status = ResultStatus.Succeeded, StartedAt = Fixtures.Start, FinishedAt = Fixtures.Start,
        Output = JsonSerializer.SerializeToElement(new SystemInfoOutput
        {
            Hostname = "CAB-1", OsVersion = new string('w', outputChars), OsBuild = "1", UptimeSeconds = 1, AgentVersion = "0.2.0", ReadOnlyMode = false, CabinetRole = null, SerialNumber = null,
        }, ContractJson.Options),
    };

    [Fact]
    public void Results_survive_a_restart_until_delivered_then_are_kept_to_answer_repeats()
    {
        using var dir = new TempDir();
        var a = Ok();
        var b = Ok();
        var outbox = new ResultOutbox(dir.Path, TimeProvider.System, _ => { });
        outbox.Add(a);
        outbox.Add(b);
        var reopened = new ResultOutbox(dir.Path, TimeProvider.System, _ => { });
        Assert.Equal(2, reopened.PendingCount);
        Assert.Equal(a.CommandId, reopened.Next()!.Value.Id);
        reopened.Delivered(a.CommandId);
        Assert.Equal(ResultOutbox.State.Delivered, reopened.StateOf(a.CommandId));
        Assert.Equal(ResultOutbox.State.Pending, reopened.StateOf(b.CommandId));
        Assert.Equal(ResultOutbox.State.None, reopened.StateOf(Guid.NewGuid()));
        var again = new ResultOutbox(dir.Path, TimeProvider.System, _ => { });
        Assert.Equal(ResultOutbox.State.Delivered, again.StateOf(a.CommandId));
        Assert.True(again.Requeue(a.CommandId));
        Assert.Equal(ResultOutbox.State.Pending, again.StateOf(a.CommandId));
        var (id, json) = again.Next()!.Value;
        Assert.Equal(b.CommandId, id);
        Assert.Equal(b.CommandId, JsonDocument.Parse(json).RootElement.GetProperty("commandId").GetGuid());
        Assert.False(again.Requeue(Guid.NewGuid()));
    }

    [Fact]
    public void Planted_damaged_and_mismatched_files_are_never_sent()
    {
        using var dir = new TempDir();
        string pending = Path.Combine(dir.Path, "pending");
        Directory.CreateDirectory(pending);
        var good = Ok();
        var other = Ok();
        File.WriteAllBytes(Path.Combine(pending, $"{good.CommandId:D}.json"), JsonSerializer.SerializeToUtf8Bytes(good, ContractJson.Options));
        // The file name and the result inside disagree.
        File.WriteAllBytes(Path.Combine(pending, $"{Guid.NewGuid():D}.json"), JsonSerializer.SerializeToUtf8Bytes(other, ContractJson.Options));
        File.WriteAllText(Path.Combine(pending, $"{Guid.NewGuid():D}.json"), "{\"commandId\":");
        File.WriteAllText(Path.Combine(pending, "..evil.json"), "{}");
        File.WriteAllText(Path.Combine(pending, $"{Guid.NewGuid():D}.json"), """{"commandId":"6f0c3a52-3b36-4c1e-9c4e-0e5b5b1f6a01","status":"succeeded","startedAt":"x"}""");
        File.WriteAllText(Path.Combine(pending, $"{Guid.NewGuid():D}.json.tmp"), "half");
        var outbox = new ResultOutbox(dir.Path, TimeProvider.System, _ => { });
        Assert.Equal(1, outbox.PendingCount);
        Assert.Equal(good.CommandId, outbox.Next()!.Value.Id);
        Assert.Single(Directory.GetFiles(pending));
        // Tampered after loading: dropped at send time, not sent.
        File.WriteAllText(Path.Combine(pending, $"{good.CommandId:D}.json"), "garbage");
        Assert.Null(outbox.Next());
    }

    [Fact]
    public void A_result_too_large_to_send_becomes_a_failure_that_says_so()
    {
        using var dir = new TempDir();
        var outbox = new ResultOutbox(dir.Path, TimeProvider.System, _ => { });
        var big = Ok(outputChars: 0) with { Output = JsonSerializer.SerializeToElement(new { blob = new string('a', ResultOutbox.MaxResultBytes) }) };
        outbox.Add(big);
        var stored = JsonDocument.Parse(outbox.Next()!.Value.Json).RootElement;
        Assert.Equal("failed", stored.GetProperty("status").GetString());
        Assert.Equal("execution_failed", stored.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public void The_outbox_is_capped_dropping_the_oldest()
    {
        using var dir = new TempDir();
        var outbox = new ResultOutbox(dir.Path, TimeProvider.System, _ => { });
        Guid first = Guid.NewGuid();
        outbox.Add(Ok(first));
        for (int i = 0; i < ResultOutbox.MaxPending; i++) outbox.Add(Ok());
        Assert.Equal(ResultOutbox.MaxPending, outbox.PendingCount);
        Assert.Equal(ResultOutbox.State.None, outbox.StateOf(first));
    }
}

public sealed class EventQueueLaneTests
{
    private static AgentEvent Event(EventKind kind = EventKind.SmartWarning, int messageLength = 20) => new()
    {
        EventId = Guid.NewGuid(), Kind = kind, OccurredAt = Fixtures.Start, SeverityHint = SeverityHint.Minor,
        Detail = new EventDetail { Message = new string('m', messageLength) },
    };

    [Fact]
    public void An_enqueue_appends_one_line_and_an_acknowledgement_only_moves_the_offset()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var q = new EventQueue(file);
        var events = Enumerable.Range(0, 5).Select(_ => Event()).ToList();
        foreach (var e in events) Assert.True(q.Enqueue(e));
        string data = Directory.GetFiles(dir.Path, "events.jsonl.main.*.jsonl").Single();
        long size = new FileInfo(data).Length;
        Assert.Equal(5, File.ReadAllLines(data).Length);
        q.Acknowledge(events.Take(2).Select(e => e.EventId));
        Assert.Equal(size, new FileInfo(data).Length); // not rewritten
        Assert.Equal(events.Skip(2).Select(e => e.EventId), new EventQueue(file).Peek().Select(e => e.Id));
    }

    [Fact]
    public void A_torn_last_line_from_a_crash_is_cut_off()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var q = new EventQueue(file);
        var a = Event();
        q.Enqueue(a);
        string data = Directory.GetFiles(dir.Path, "events.jsonl.main.*.jsonl").Single();
        File.AppendAllText(data, "{\"eventId\":\"half a li");
        var reopened = new EventQueue(file);
        Assert.Equal(new[] { a.EventId }, reopened.Peek().Select(e => e.Id));
        var b = Event();
        reopened.Enqueue(b);
        Assert.Equal(new[] { a.EventId, b.EventId }, new EventQueue(file).Peek().Select(e => e.Id));
    }

    [Fact]
    public void A_compaction_that_did_not_finish_is_ignored_and_a_garbage_ack_file_is_survived()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var q = new EventQueue(file);
        var a = Event();
        q.Enqueue(a);
        File.WriteAllText(file + ".main.99.jsonl", JsonSerializer.Serialize(Event(), ContractJson.Options) + "\n");
        Assert.Equal(new[] { a.EventId }, new EventQueue(file).Peek().Select(e => e.Id));
        Assert.False(File.Exists(file + ".main.99.jsonl"));
        File.WriteAllText(file + ".main.ack", "-1 x \0 9999999999999999999999");
        var survived = new EventQueue(file);
        Assert.Equal(new[] { a.EventId }, survived.Peek().Select(e => e.Id));
    }

    [Fact]
    public void Compaction_keeps_the_queue_across_restarts()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var q = new EventQueue(file);
        var events = Enumerable.Range(0, 300).Select(_ => Event(messageLength: 4000)).ToList();
        foreach (var e in events) q.Enqueue(e);
        q.Acknowledge(events.Take(290).Select(e => e.EventId)); // > 1 MB acknowledged: compacted
        Assert.EndsWith(".main.1.jsonl", Directory.GetFiles(dir.Path, "events.jsonl.main.*.jsonl").Single(), StringComparison.Ordinal);
        Assert.Equal(events.Skip(290).Select(e => e.EventId), new EventQueue(file).Peek().Select(e => e.Id));
    }

    [Fact]
    public void Security_and_status_events_have_their_own_lane_that_goes_first_and_is_never_evicted()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var q = new EventQueue(file);
        var security = Event(EventKind.Security);
        Assert.True(q.Enqueue(security));
        for (int i = 0; i < EventQueue.MaxEvents + 10; i++) q.Enqueue(Event());
        Assert.Equal(10, q.Dropped);
        Assert.Equal(new[] { security.EventId }, q.PeekBatch(100).Select(e => e.Id));
        Assert.Equal(EventQueue.MaxEvents + 1, q.Count);
        var reopened = new EventQueue(file);
        Assert.Equal(10, reopened.Dropped);
        Assert.Equal(1, reopened.PriorityCount);
    }

    [Fact]
    public void A_full_priority_lane_refuses_new_events_and_counts_them()
    {
        var q = new EventQueue(null);
        for (int i = 0; i < EventQueue.MaxPriorityEvents; i++) Assert.True(q.Enqueue(Event(EventKind.AgentStatus)));
        Assert.False(q.Enqueue(Event(EventKind.Security)));
        Assert.Equal(1, q.Dropped);
        Assert.Equal(EventQueue.MaxPriorityEvents, q.PriorityCount);
    }

    [Fact]
    public void Batches_are_capped_by_bytes_as_well_as_count()
    {
        var q = new EventQueue(null);
        for (int i = 0; i < 100; i++) q.Enqueue(Event(messageLength: 3900)); // ~4 KB each
        var batch = q.PeekBatch(100);
        Assert.InRange(batch.Count, 50, 70);
        Assert.True(batch.Sum(b => b.Json.Length) <= EventQueue.MaxBatchBytes);
        Assert.Equal(7, q.PeekBatch(7).Count);
        Assert.Single(q.PeekBatch(100, maxBytes: 10)); // never empty while events wait
    }

    [Fact]
    public void An_event_set_aside_goes_to_its_own_file_and_is_counted()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var q = new EventQueue(file);
        var bad = Event();
        var good = Event();
        q.Enqueue(bad);
        q.Enqueue(good);
        q.SetAsideEvent(bad.EventId);
        Assert.Equal(1, q.SetAside);
        Assert.Equal(new[] { good.EventId }, q.Peek().Select(e => e.Id));
        Assert.Contains(bad.EventId.ToString(), File.ReadAllText(file + ".set-aside.jsonl"));
        var reopened = new EventQueue(file);
        Assert.Equal(1, reopened.SetAside);
        Assert.Equal(new[] { good.EventId }, reopened.Peek().Select(e => e.Id));
    }

    [Fact]
    public void A_queue_from_before_protocol_1_1_is_taken_over()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var a = Event();
        var s = Event(EventKind.Security);
        File.WriteAllText(file, JsonSerializer.Serialize(a, ContractJson.Options) + "\nnot json\n" + JsonSerializer.Serialize(s, ContractJson.Options) + "\n");
        var q = new EventQueue(file);
        Assert.False(File.Exists(file));
        Assert.Equal(new[] { s.EventId }, q.Peek().Select(e => e.Id));
        q.Acknowledge([s.EventId]);
        Assert.Equal(new[] { a.EventId }, new EventQueue(file).Peek().Select(e => e.Id));
    }

    [Fact]
    public void Removing_from_the_middle_does_not_bring_events_back_after_a_restart()
    {
        using var dir = new TempDir();
        string file = dir.File("events.jsonl");
        var q = new EventQueue(file);
        var events = Enumerable.Range(0, 3).Select(_ => Event()).ToList();
        foreach (var e in events) q.Enqueue(e);
        q.Acknowledge([events[1].EventId]);
        Assert.Equal(new[] { events[0].EventId, events[2].EventId }, new EventQueue(file).Peek().Select(e => e.Id));
    }
}
