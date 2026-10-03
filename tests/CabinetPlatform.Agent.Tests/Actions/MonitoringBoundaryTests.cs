using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Tests.Actions;

public class MonitoringBoundaryTests
{
#if !LEGACY_MAINTENANCE_TESTS
    private static readonly ActionName[] Observations =
    [ActionName.GetProcessList, ActionName.CollectEventLogs, ActionName.RunEventLogView, ActionName.GetScheduledUpdates, ActionName.InspectFirewall, ActionName.GetDisplayDiagnostics, ActionName.GetWerMetadata, ActionName.GetHistoricalProcessEvidence];

    [Theory]
    [InlineData("Demo")]
    [InlineData("Maintenance")]
    [InlineData("DiagnosticOnly")]
    [InlineData("unexpected")]
    public async Task Legacy_config_cannot_dispatch_mutations_even_with_an_injected_executor(string mode)
    {
        var cabinetId = Guid.NewGuid();
        var state = new InMemoryAgentStateStore(new AgentState
        { MachineId = "synthetic", CabinetId = cabinetId, RegistrationStatus = RegistrationStatus.Approved });
        var executors = Enum.GetValues<ActionName>().Append((ActionName)9999).Select(a => new RecordingExecutor(a)).ToArray();
        var dispatcher = new ActionDispatcher(new ActionExecutorRegistry(executors, NullLogger<ActionExecutorRegistry>.Instance),
            state, new FixedClock(DateTimeOffset.UtcNow), Options.Create(new AgentOptions { Actions = new() { ExecutionMode = mode } }),
            NullLogger<ActionDispatcher>.Instance);
        foreach (var executor in executors)
        {
            var result = await dispatcher.DispatchAsync(new ActionRequestDto
            {
                Id = Guid.NewGuid(), CabinetId = cabinetId, Action = executor.Action,
                Reason = "Persisted legacy action", RequestedByUserId = Guid.NewGuid(), RequestedUtc = DateTimeOffset.UtcNow
            }, default);
            Assert.Equal(Observations.Contains(executor.Action) ? ActionStatus.Succeeded : ActionStatus.Denied, result.Status);
            Assert.Equal(Observations.Contains(executor.Action) ? 1 : 0, executor.Calls);
        }
    }

    [Theory]
    [InlineData("Demo")]
    [InlineData("Maintenance")]
    public void Shipped_composition_registers_only_observations(string mode)
    {
        var services = new ServiceCollection();
        services.AddCabinetAgent(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["Agent:Actions:ExecutionMode"] = mode }).Build());
        var registered = services.Where(s => s.ServiceType == typeof(IActionExecutor)).Select(s => s.ImplementationType!.Name).Order();
        Assert.Equal(new[] { "CollectEventLogsExecutor", "GetDisplayDiagnosticsExecutor", "GetHistoricalProcessEvidenceExecutor", "GetProcessListExecutor", "GetScheduledUpdatesExecutor", "GetWerMetadataExecutor", "InspectFirewallExecutor", "RunEventLogViewExecutor" }.Order(), registered);
    }

#endif
    [Fact]
    public void No_composition_registers_retired_peer_icmp_executors()
    {
        var services = new ServiceCollection();
        services.AddCabinetAgent(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["Agent:Actions:ExecutionMode"] = "Maintenance" }).Build());
        Assert.DoesNotContain(services, s => s.ServiceType == typeof(IActionExecutor) &&
            (s.ImplementationType?.Name is "PingCabinetExecutor" or "TraceRouteToCabinetExecutor"));
    }

#if !LEGACY_MAINTENANCE_TESTS
    [Theory]
    [InlineData("Demo")]
    [InlineData("Maintenance")]
    public void Restart_preserves_real_persisted_schedules_and_network_journals_without_effects(string mode)
    {
        var directory = Path.Combine(Path.GetTempPath(), "monitoring-boundary-" + Guid.NewGuid());
        var options = Options.Create(new AgentOptions { StateDirectory = directory, Actions = new() { ExecutionMode = mode } });
        try
        {
            var state = new FileAgentStateStore(options, NullLogger<FileAgentStateStore>.Instance);
            var schedule = new ScheduledUpdateWriter(state, NullLogger<ScheduledUpdateWriter>.Instance);
            schedule.Schedule(new ScheduledUpdateInstall
            {
                ActionRequestId = Guid.NewGuid(), RequestedByUserId = Guid.NewGuid(),
                ScheduledForUtc = DateTimeOffset.UtcNow.AddDays(-1), UpdateIds = ["synthetic-update"], RebootIfRequired = true
            });
            var rollback = new FileNetworkRollbackStore(options, NullLogger<FileNetworkRollbackStore>.Instance);
            rollback.Write(new NetworkRollback
            {
                ActionRequestId = Guid.NewGuid(), AppliedUtc = DateTimeOffset.UtcNow.AddDays(-1),
                Previous = new AdapterConfiguration { AdapterId = "synthetic-adapter", DhcpEnabled = true }
            });
            var before = Directory.GetFiles(directory).ToDictionary(p => Path.GetFileName(p)!, File.ReadAllText);
            // Reopen both stores: these are persisted upgrade artifacts, not injected queue values.
            var reopened = new FileAgentStateStore(options, NullLogger<FileAgentStateStore>.Instance);
            var updates = new StubUpdateGateway();
            var network = new StubNetworkGateway(null);
            var runner = new ScheduledUpdateRunner(new ScheduledUpdateWriter(reopened, NullLogger<ScheduledUpdateWriter>.Instance),
                updates, new FileNetworkRollbackStore(options, NullLogger<FileNetworkRollbackStore>.Instance), network,
                reopened, new FixedClock(DateTimeOffset.UtcNow), NullLogger<ScheduledUpdateRunner>.Instance, options);
            runner.RecoverInterruptedNetworkChange();
            runner.RunDueInstall(default);
            Assert.Empty(updates.Installed);
            Assert.False(network.Restored);
            Assert.NotNull(reopened.Load().ScheduledUpdate);
            Assert.NotNull(rollback.Read());
            Assert.Empty(reopened.Load().PendingUpdateOutcomes);
            foreach (var file in Directory.GetFiles(directory)) Assert.Equal(before[Path.GetFileName(file)], File.ReadAllText(file));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private sealed class RecordingExecutor(ActionName action) : IActionExecutor
    {
        public ActionName Action => action;
        public int Calls { get; private set; }
        public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
        { Calls++; return Task.FromResult(ActionOutcome.Succeeded("Observation")); }
    }
#endif
}
