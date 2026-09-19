using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Reflection;
using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Tests.Actions;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests;

public sealed class WorkerReportingTests
{
    [Fact]
    public async Task RepeatedMidFlushDisconnectsBackOffWithoutPollingOrDroppingTheReport()
    {
        using var fixture = new Fixture();
        fixture.Buffer.Enqueue(fixture.Builder.BuildIdentityOnly(), CheckInTier.Full);
        fixture.Client.Send = (_, _, _) => Task.FromResult(new CheckInResult
        {
            Outcome = fixture.Client.CheckIns % 2 == 1 ? CheckInOutcome.Accepted : CheckInOutcome.Failed,
        });

        for (var failure = 1; failure <= 8; failure++)
        {
            await fixture.Tick();
            var delay = fixture.NextDelay();
            var ceiling = Math.Min(30 * Math.Pow(2, failure - 1), 1800);
            Assert.InRange(delay.TotalSeconds, ceiling / 2, ceiling);
            Assert.Equal(1, fixture.Buffer.Count);
            Assert.Equal(0, fixture.Client.Polls);
        }

        fixture.Client.Send = (_, _, _) => Task.FromResult(new CheckInResult { Outcome = CheckInOutcome.Accepted });
        await fixture.Tick();
        Assert.Equal(0, fixture.Buffer.Count);
        Assert.Equal(1, fixture.Client.Polls);
        Assert.InRange(fixture.NextDelay().TotalSeconds, 285, 315);
    }

    [Fact]
    public async Task CancellationDuringFreshSendPreservesTheUnacknowledgedReportAndPropagates()
    {
        using var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        CheckInPayload? sent = null;
        fixture.Client.Send = (payload, _, token) =>
        {
            sent = payload;
            cancellation.Cancel();
            return Task.FromCanceled<CheckInResult>(token);
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Tick(cancellation.Token));

        var buffered = Assert.Single(fixture.Buffer.PeekOldest(10));
        Assert.Same(sent, buffered.Payload);
        Assert.Equal(CheckInTier.Full, buffered.Tier);
        Assert.Equal(1, fixture.Client.CheckIns);
        Assert.Equal(0, fixture.Client.Polls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SpoolFailureIsReportedAsDataLossNotQueuedSuccess(bool cancel)
    {
        using var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        fixture.Buffer.CanEnqueue = false;
        fixture.Client.Send = (_, _, token) =>
        {
            if (cancel)
            {
                cancellation.Cancel();
                return Task.FromCanceled<CheckInResult>(token);
            }
            return Task.FromResult(new CheckInResult { Outcome = CheckInOutcome.Failed });
        };

        if (cancel)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Tick(cancellation.Token));
        }
        else
        {
            await fixture.Tick();
        }

        Assert.Empty(fixture.Buffer.PeekOldest(10));
        Assert.Contains(fixture.Logger.Entries, entry => entry.Level == Microsoft.Extensions.Logging.LogLevel.Error &&
            entry.Message.Contains("could not be spooled", StringComparison.Ordinal));
        Assert.DoesNotContain(fixture.Logger.Entries, entry => entry.Message.Contains("has been spooled", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BufferedReplayIsBoundedToFiveReportsPerTick()
    {
        using var fixture = new Fixture();
        for (var i = 0; i < 8; i++)
            fixture.Buffer.Enqueue(fixture.Builder.BuildIdentityOnly(), CheckInTier.Full);
        fixture.Client.Send = (_, _, _) => Task.FromResult(new CheckInResult { Outcome = CheckInOutcome.Accepted });

        await fixture.Tick();

        Assert.Equal(6, fixture.Client.CheckIns); // one fresh sample plus five queued samples
        Assert.Equal(3, fixture.Buffer.Count);
        Assert.Equal(1, fixture.Client.Polls);
    }

    [Fact]
    public async Task CancellationDuringReplayKeepsTheReportAndStopsFurtherRequests()
    {
        using var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        fixture.Buffer.Enqueue(fixture.Builder.BuildIdentityOnly(), CheckInTier.Full);
        fixture.Client.Send = (_, _, token) =>
        {
            if (fixture.Client.CheckIns == 1)
                return Task.FromResult(new CheckInResult { Outcome = CheckInOutcome.Accepted });
            cancellation.Cancel();
            return Task.FromCanceled<CheckInResult>(token);
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Tick(cancellation.Token));

        Assert.Equal(1, fixture.Buffer.Count);
        Assert.Equal(2, fixture.Client.CheckIns);
        Assert.Equal(0, fixture.Client.Polls);
    }

    [Fact]
    public async Task ServiceStopCancelsTheBackoffDelayWithoutAnotherSend()
    {
        using var fixture = new Fixture();
        await fixture.Worker.StartAsync(CancellationToken.None);
        await fixture.Logger.BackingOff.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        await fixture.Worker.StopAsync(deadline.Token);
        await fixture.Worker.ExecuteTask!.WaitAsync(deadline.Token);

        Assert.Equal(1, fixture.Client.CheckIns);
        Assert.Equal(1, fixture.Buffer.Count);
        Assert.Equal(0, fixture.Client.Polls);
    }

    [Fact]
    public async Task HttpFailureSurvivesBufferReopenAndOnlyAcknowledgedReplayIsRemoved()
    {
        var directory = Path.Combine(Path.GetTempPath(), "reporting-test-" + Guid.NewGuid().ToString("N"));
        var options = new AgentOptions { Buffer = new BufferOptions { Directory = directory } };
        var clock = new FixedClock(DateTimeOffset.UtcNow);
        FilePayloadBuffer OpenBuffer() => new(TestOptions.Create(options), clock, NullLogger<FilePayloadBuffer>.Instance);
        using var handler = new SequencedHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://synthetic.invalid/") };
        var transport = new ServerClient(new ClientFactory(http), NullLogger<ServerClient>.Instance);
        try
        {
            using (var first = new Fixture(transport, OpenBuffer()))
                await first.Tick();
            var persisted = Assert.Single(OpenBuffer().PeekOldest(10));
            Assert.Equal(CheckInTier.Full, persisted.Tier);

            using var restarted = new Fixture(transport, OpenBuffer());
            await restarted.Tick(); // fresh report acknowledged, replay disconnects
            Assert.Equal(persisted.Id, Assert.Single(OpenBuffer().PeekOldest(10)).Id);
            Assert.InRange(restarted.NextDelay().TotalSeconds, 15, 30);
            Assert.Equal(0, handler.Polls);

            await restarted.Tick(); // next fresh report and replay acknowledged
            Assert.Empty(OpenBuffer().PeekOldest(10));
            Assert.Equal(1, handler.Polls);
            Assert.Equal(5, handler.Reports.Count);
            Assert.Equal(persisted.Payload.CollectedAtUtc, handler.Reports[2].Payload.CollectedAtUtc);
            Assert.Equal(persisted.Payload.CollectedAtUtc, handler.Reports[4].Payload.CollectedAtUtc);
            Assert.Equal(new[] { "/api/agent/checkin/full", "/api/agent/checkin/full", "/api/agent/checkin/full",
                "/api/agent/checkin", "/api/agent/checkin/full" }, handler.Reports.Select(report => report.Path));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    private sealed class SequencedHandler : HttpMessageHandler
    {
        public List<(string Path, CheckInPayload Payload)> Reports { get; } = new();
        public int Polls { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.Method == HttpMethod.Get)
            {
                Polls++;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(Array.Empty<ActionRequestDto>()) };
            }
            var payload = await request.Content!.ReadFromJsonAsync<CheckInPayload>(AgentJson.SerializerOptions, token);
            Assert.NotNull(payload);
            Reports.Add((request.RequestUri!.AbsolutePath, payload));
            return new HttpResponseMessage(Reports.Count is 1 or 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
            {
                Content = new StringContent("{}"),
            };
        }
    }

    private sealed class ClientFactory(HttpClient client) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => client;
    }

    private sealed class Fixture : IDisposable
    {
        public ScriptedClient Client { get; } = new();
        public MemoryBuffer Buffer { get; } = new();
        public CheckInBuilder Builder { get; }
        public Worker Worker { get; }
        public RecordingLogger Logger { get; } = new();

        public Fixture(IServerClient? transport = null, IPayloadBuffer? buffer = null)
        {
            var state = new InMemoryAgentStateStore(new AgentState
            {
                CabinetId = Guid.NewGuid(),
                RegistrationStatus = RegistrationStatus.Approved,
            });
            var clock = new FixedClock(DateTimeOffset.UtcNow);
            var identity = new Identity();
            var registration = new RegistrationService(transport ?? Client, state, identity, new FakeWmiRepository(), clock, NullLogger<RegistrationService>.Instance);
            var runner = new ScheduledUpdateRunner(new StubScheduleWriter(), new StubUpdateGateway(),
                new StubRollbackStore(), new StubNetworkGateway(null), state, clock, NullLogger<ScheduledUpdateRunner>.Instance);
            Builder = new CheckInBuilder(Array.Empty<ICollector>(), identity, state, clock, NullLogger<CheckInBuilder>.Instance);
            var options = TestOptions.Create(new AgentOptions());
            var dispatcher = new ActionDispatcher(
                new ActionExecutorRegistry(Array.Empty<IActionExecutor>(), NullLogger<ActionExecutorRegistry>.Instance),
                state, clock, options, NullLogger<ActionDispatcher>.Instance);
            Worker = new Worker(Builder, transport ?? Client, buffer ?? Buffer, registration, dispatcher, runner, state, options, Logger);
        }

        public Task Tick(CancellationToken token = default) =>
            (Task)typeof(Worker).GetMethod("TickAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(Worker, new object[] { token })!;
        public TimeSpan NextDelay() =>
            (TimeSpan)typeof(Worker).GetMethod("NextDelay", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(Worker, null)!;
        public void Dispose() => Worker.Dispose();
    }

    private sealed class Identity : IMachineIdentityProvider
    {
        public string GetMachineId() => "synthetic-reporting-machine";
    }

    private sealed class MemoryBuffer : IPayloadBuffer
    {
        private readonly List<BufferedPayload> _items = new();
        public int Count => _items.Count;
        public bool CanEnqueue { get; set; } = true;
        public bool Enqueue(CheckInPayload payload, CheckInTier tier)
        {
            if (!CanEnqueue) return false;
            _items.Add(new BufferedPayload { Id = Guid.NewGuid().ToString(), Payload = payload, Tier = tier });
            return true;
        }
        public IReadOnlyList<BufferedPayload> PeekOldest(int maximumCount) => _items.Take(maximumCount).ToArray();
        public void Remove(string id) => _items.RemoveAll(item => item.Id == id);
    }

    private sealed class RecordingLogger : ILogger<Worker>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = new();
        public TaskCompletionSource BackingOff { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var message = formatter(state, exception);
            Entries.Add((level, message));
            if (message.StartsWith("Backing off", StringComparison.Ordinal)) BackingOff.TrySetResult();
        }
    }

    private sealed class ScriptedClient : IServerClient
    {
        public int CheckIns { get; private set; }
        public int Polls { get; private set; }
        public Func<CheckInPayload, CheckInTier, CancellationToken, Task<CheckInResult>> Send { get; set; } =
            (_, _, _) => Task.FromResult(new CheckInResult { Outcome = CheckInOutcome.Failed });
        public Task<CheckInResult> CheckInAsync(CheckInPayload payload, CheckInTier tier, CancellationToken token)
        {
            CheckIns++;
            return Send(payload, tier, token);
        }
        public Task<RegistrationResponse?> RegisterAsync(RegistrationRequest request, CancellationToken token) =>
            throw new InvalidOperationException("An approved cabinet should not re-register.");
        public Task<IReadOnlyList<ActionRequestDto>> GetPendingActionsAsync(Guid cabinetId, CancellationToken token)
        {
            Polls++;
            return Task.FromResult<IReadOnlyList<ActionRequestDto>>(Array.Empty<ActionRequestDto>());
        }
        public Task<bool> ReportActionResultAsync(ActionResultDto result, CancellationToken token) =>
            throw new InvalidOperationException("These tests do not execute actions.");
    }
}
