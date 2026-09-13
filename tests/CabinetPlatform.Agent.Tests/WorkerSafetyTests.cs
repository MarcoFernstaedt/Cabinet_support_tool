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
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests;

public class WorkerSafetyTests
{
    [Fact]
    public async Task RevocationStopsNextTickDiagnosticsAndDueInstall()
    {
        var state = new InMemoryAgentStateStore(new AgentState { CabinetId = Guid.NewGuid(), RegistrationStatus = RegistrationStatus.Approved });
        var clock = new FixedClock(DateTimeOffset.UtcNow);
        var client = new RefusingClient();
        var identity = new Identity();
        var collector = new CounterCollector();
        var registration = new RegistrationService(client, state, identity, new FakeWmiRepository(), clock, NullLogger<RegistrationService>.Instance);
        var schedule = new StubScheduleWriter();
        var updates = new StubUpdateGateway();
        var runner = new ScheduledUpdateRunner(schedule, updates, new StubRollbackStore(), new StubNetworkGateway(null), state, clock, NullLogger<ScheduledUpdateRunner>.Instance);
        var builder = new CheckInBuilder(new[] { collector }, identity, state, clock, NullLogger<CheckInBuilder>.Instance);
        using var worker = new Worker(builder, client, null!, registration, null!, runner, state, TestOptions.Create(new AgentOptions()), NullLogger<Worker>.Instance);
        await Tick(worker);
        Assert.False(state.Load().IsApproved);
        schedule.Schedule = new ScheduledUpdateInstall { ActionRequestId = Guid.NewGuid(), RequestedByUserId = Guid.NewGuid(), ScheduledForUtc = clock.UtcNow, UpdateIds = new[] { "synthetic" }, RebootIfRequired = false };
        await Tick(worker);
        Assert.Equal(1, collector.Calls);
        Assert.Empty(updates.Installed);
        Assert.Equal(1, client.Registrations);
    }

    [Fact]
    public async Task RevocationDuringBufferFlushStopsActionPolling()
    {
        var state = new InMemoryAgentStateStore(new AgentState { CabinetId = Guid.NewGuid(), RegistrationStatus = RegistrationStatus.Approved });
        var clock = new FixedClock(DateTimeOffset.UtcNow);
        var client = new RefusingClient();
        var identity = new Identity();
        var registration = new RegistrationService(client, state, identity, new FakeWmiRepository(), clock, NullLogger<RegistrationService>.Instance);
        var builder = new CheckInBuilder(Array.Empty<ICollector>(), identity, state, clock, NullLogger<CheckInBuilder>.Instance);
        using var worker = new Worker(builder, client, new Buffer(builder.BuildIdentityOnly()), registration, null!, null!, state, TestOptions.Create(new AgentOptions()), NullLogger<Worker>.Instance);
        await (Task)typeof(Worker).GetMethod("FlushBufferAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, new object[] { CancellationToken.None })!;
        Assert.False(state.Load().IsApproved);
        await (Task)typeof(Worker).GetMethod("PollAndRunActionsAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, new object[] { CancellationToken.None })!;
    }

    private sealed class Buffer(CheckInPayload payload) : IPayloadBuffer
    {
        public int Count => 1;
        public bool Enqueue(CheckInPayload value, CheckInTier tier) => throw new NotSupportedException();
        public IReadOnlyList<BufferedPayload> PeekOldest(int maximumCount) => new[] { new BufferedPayload { Id = "synthetic", Payload = payload, Tier = CheckInTier.Full } };
        public void Remove(string id) => throw new InvalidOperationException("Refused payload must remain buffered");
    }

    private static Task Tick(Worker worker) => (Task)typeof(Worker).GetMethod("TickAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, new object[] { CancellationToken.None })!;
    private sealed class Identity : IMachineIdentityProvider { public string GetMachineId() => "synthetic-machine"; }
    private sealed class CounterCollector : ICollector
    {
        public int Calls;
        public bool RunsOnHeartbeat => true;
        public string SectionName => CollectorSections.System;
        public Task CollectAsync(CheckInDraft draft, CheckInTier tier, CancellationToken token) { Calls++; return Task.CompletedTask; }
    }
    private sealed class RefusingClient : IServerClient
    {
        public int Registrations;
        public Task<RegistrationResponse?> RegisterAsync(RegistrationRequest request, CancellationToken token) { Registrations++; return Task.FromResult<RegistrationResponse?>(null); }
        public Task<CheckInResult> CheckInAsync(CheckInPayload payload, CheckInTier tier, CancellationToken token) => Task.FromResult(new CheckInResult { Outcome = CheckInOutcome.NotApproved });
        public Task<IReadOnlyList<ActionRequestDto>> GetPendingActionsAsync(Guid cabinet, CancellationToken token) => throw new InvalidOperationException("Must not poll revoked cabinet");
        public Task<bool> ReportActionResultAsync(ActionResultDto result, CancellationToken token) => Task.FromResult(false);
    }
}
