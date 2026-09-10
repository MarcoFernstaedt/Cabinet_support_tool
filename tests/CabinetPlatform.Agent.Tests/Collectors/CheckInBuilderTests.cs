using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Collectors;

public class CheckInBuilderTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 10, 18, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task BuildAsync_RunsEveryCollectorAndStampsIdentity()
    {
        var builder = Builder(
            new StubCollector(CollectorSections.System, draft => draft.System = new SystemInfo { Hostname = "CABINET-07" }),
            new StubCollector(CollectorSections.Services, draft => draft.Services = Array.Empty<ServiceInfo>()));

        var payload = await builder.BuildAsync(CancellationToken.None);

        Assert.Equal("machine-hash", payload.MachineId);
        Assert.Equal(Now, payload.CollectedAtUtc);
        Assert.Equal("CABINET-07", payload.System!.Hostname);
        Assert.NotNull(payload.Services);
        Assert.Empty(payload.SectionErrors);
        Assert.False(string.IsNullOrWhiteSpace(payload.AgentVersion));
    }

    [Fact]
    public async Task BuildAsync_RecordsAFailingCollectorAndKeepsGoing()
    {
        // This is the behaviour the whole design turns on. A cabinet whose
        // Windows Update COM surface hangs still reports its disks, and the
        // hang itself becomes a visible finding instead of a lost check-in.
        var builder = Builder(
            new StubCollector(CollectorSections.WindowsUpdate, _ => throw new TimeoutException("WUA did not respond.")),
            new StubCollector(CollectorSections.Disks, draft => draft.Disks = new[]
            {
                new DiskInfo
                {
                    DriveLetter = "C",
                    BitLockerStatus = BitLockerStatus.EncryptedUnlocked,
                    HealthStatus = DiskHealthStatus.Healthy,
                },
            }));

        var payload = await builder.BuildAsync(CancellationToken.None);

        Assert.NotNull(payload.Disks);
        Assert.Single(payload.Disks!);

        var error = Assert.Single(payload.SectionErrors);
        Assert.Equal(CollectorSections.WindowsUpdate, error.Key);

        // The exception type is kept: "Access is denied" and
        // "TimeoutException: ..." send an engineer to different places.
        Assert.Contains("TimeoutException", error.Value, StringComparison.Ordinal);
        Assert.Contains("WUA did not respond.", error.Value, StringComparison.Ordinal);

        // The section that failed is null rather than half-populated.
        Assert.Null(payload.WindowsUpdate);
    }

    [Fact]
    public async Task BuildAsync_ReturnsAPayloadEvenWhenEveryCollectorFails()
    {
        var builder = Builder(
            new StubCollector(CollectorSections.System, _ => throw new InvalidOperationException("no wmi")),
            new StubCollector(CollectorSections.Network, _ => throw new InvalidOperationException("no network")));

        var payload = await builder.BuildAsync(CancellationToken.None);

        Assert.Equal(2, payload.SectionErrors.Count);
        Assert.Equal("machine-hash", payload.MachineId);
    }

    [Fact]
    public async Task BuildAsync_StopsAtTheNextCollectorWhenCancelled()
    {
        // Shutdown is not a section failure. It must propagate rather than be
        // swallowed into SectionErrors, and it must stop the collectors that
        // have not run yet instead of working through the whole list.
        using var cancellation = new CancellationTokenSource();
        var secondCollectorRan = false;

        var builder = Builder(
            new StubCollector(CollectorSections.System, _ => cancellation.Cancel()),
            new StubCollector(CollectorSections.Network, _ => secondCollectorRan = true));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => builder.BuildAsync(cancellation.Token));

        Assert.False(secondCollectorRan);
    }

    [Fact]
    public async Task BuildAsync_DoesNotRecordCancellationAsASectionFailure()
    {
        using var cancellation = new CancellationTokenSource();

        var builder = Builder(
            new StubCollector(CollectorSections.System, _ =>
            {
                cancellation.Cancel();
                cancellation.Token.ThrowIfCancellationRequested();
            }));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => builder.BuildAsync(cancellation.Token));
    }

    [Fact]
    public void BuildIdentityOnly_CarriesNoDiagnosticData()
    {
        // Before approval a cabinet reports who it is and nothing else. This is
        // the agent's own half of "reports nothing usable until approved" and
        // does not rely on the server rejecting the payload.
        var builder = Builder(
            new StubCollector(CollectorSections.System, draft => draft.System = new SystemInfo { Hostname = "leaked" }));

        var payload = builder.BuildIdentityOnly();

        Assert.Equal("machine-hash", payload.MachineId);
        Assert.Null(payload.System);
        Assert.Null(payload.Performance);
        Assert.Null(payload.Services);
        Assert.Null(payload.Disks);
        Assert.Null(payload.EventLogs);
        Assert.Null(payload.WindowsUpdate);
        Assert.Null(payload.Network);
        Assert.Empty(payload.SectionErrors);
    }

    [Fact]
    public async Task BuildAsync_IncludesTheCabinetIdOnceApproved()
    {
        var cabinetId = Guid.NewGuid();
        var stateStore = new InMemoryAgentStateStore(new AgentState
        {
            MachineId = "machine-hash",
            CabinetId = cabinetId,
            RegistrationStatus = Contracts.Auth.RegistrationStatus.Approved,
        });

        var builder = new CheckInBuilder(
            Array.Empty<ICollector>(),
            new StubIdentityProvider(),
            stateStore,
            new FixedClock(Now),
            NullLogger<CheckInBuilder>.Instance);

        var payload = await builder.BuildAsync(CancellationToken.None);

        Assert.Equal(cabinetId, payload.CabinetId);
    }

    private static CheckInBuilder Builder(params ICollector[] collectors)
        => new(
            collectors,
            new StubIdentityProvider(),
            new InMemoryAgentStateStore(new AgentState { MachineId = "machine-hash" }),
            new FixedClock(Now),
            NullLogger<CheckInBuilder>.Instance);

    private sealed class StubCollector : ICollector
    {
        private readonly Action<CheckInDraft> _collect;

        public StubCollector(string sectionName, Action<CheckInDraft> collect)
        {
            SectionName = sectionName;
            _collect = collect;
        }

        public string SectionName { get; }

        public Task CollectAsync(CheckInDraft draft, CancellationToken cancellationToken)
        {
            _collect(draft);
            return Task.CompletedTask;
        }
    }

    private sealed class StubIdentityProvider : IMachineIdentityProvider
    {
        public string GetMachineId() => "machine-hash";
    }
}
