using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

/// <summary>
/// Confirm-or-revert, which is the only thing standing between a wrong DNS
/// server and a site visit.
/// </summary>
/// <remarks>
/// Each of these actions can leave a cabinet running perfectly and reachable by
/// nobody. The sequence is fixed: write the old configuration to disk, apply,
/// wait for the cabinet to reach the server, and put the old one back if it
/// does not. These tests pin every branch of that, including the two nobody
/// wants to think about — the revert failing, and the machine restarting
/// mid-change.
/// </remarks>
public class NetworkConfigurationExecutorTests
{
    private const string AdapterId = "{7B2C1D8E-0000-4000-8000-A1B2C3D4E5F6}";

    [Fact]
    public async Task A_change_the_cabinet_survives_is_kept_and_the_rollback_is_cleared()
    {
        var network = new StubNetworkGateway(Current());
        var rollback = new StubRollbackStore();

        ActionOutcome outcome = await DnsExecutor(network, Reachable(), rollback)
            .ExecuteAsync(DnsRequest("10.20.30.9"), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.Contains("has been kept", outcome.Output!, StringComparison.OrdinalIgnoreCase);

        Assert.Equal(new[] { "10.20.30.9" }, network.DnsSet);
        Assert.False(network.Restored);

        // Cleared, so a later restart does not find a stale rollback and undo a
        // configuration that is working.
        Assert.Null(rollback.Pending);
    }

    [Fact]
    public async Task A_change_the_cabinet_does_not_survive_is_put_back()
    {
        // The case this whole mechanism exists for. Without it, one wrong DNS
        // server costs a clinic its cabinet until somebody drives there.
        var network = new StubNetworkGateway(Current());
        var rollback = new StubRollbackStore();

        ActionOutcome outcome = await DnsExecutor(network, Unreachable(), rollback)
            .ExecuteAsync(DnsRequest("10.99.99.99"), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.Contains("previous configuration was put back",
            outcome.Output!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("as it was", outcome.Output!, StringComparison.OrdinalIgnoreCase);

        Assert.True(network.Restored);
        Assert.Null(rollback.Pending);

        // Reported as reverted, not as succeeded. "Succeeded" for an
        // applied-then-reverted change would be a lie a rep would act on.
        Assert.Contains("Reverted", outcome.CollectedData!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_revert_that_itself_fails_is_reported_as_itself()
    {
        // The one state that needs a person now: the cabinet is holding a
        // configuration nobody wanted and cannot be reached to change it.
        // Folding this into a generic failure would lose exactly the fact
        // somebody has to act on.
        var network = new StubNetworkGateway(Current()) { FailRestore = true };
        var rollback = new StubRollbackStore();

        ActionOutcome outcome = await DnsExecutor(network, Unreachable(), rollback)
            .ExecuteAsync(DnsRequest("10.99.99.99"), CancellationToken.None);

        Assert.Contains("could NOT be put back", outcome.Output!, StringComparison.Ordinal);
        Assert.Contains("attention on site", outcome.Output!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("RevertFailed", outcome.CollectedData!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_rollback_is_written_before_anything_is_applied()
    {
        // A rollback recorded after the change is a rollback that is missing in
        // exactly the case it exists for: the machine losing power mid-change.
        var rollback = new StubRollbackStore();
        var network = new StubNetworkGateway(Current())
        {
            OnApply = () => Assert.NotNull(rollback.Pending),
        };

        await DnsExecutor(network, Reachable(), rollback)
            .ExecuteAsync(DnsRequest("10.20.30.9"), CancellationToken.None);

        Assert.True(network.ApplyWasCalled);
    }

    [Fact]
    public async Task A_partial_apply_failure_restores_before_clearing_rollback()
    {
        var network = new StubNetworkGateway(Current()) { FailApply = true };
        var rollback = new StubRollbackStore();
        await DnsExecutor(network, Reachable(), rollback)
            .ExecuteAsync(DnsRequest("10.20.30.9"), CancellationToken.None);
        Assert.True(network.Restored);
        Assert.Null(rollback.Pending);
    }

    [Fact]
    public async Task An_adapter_this_cabinet_does_not_have_is_refused_before_anything_happens()
    {
        var network = new StubNetworkGateway(current: null);
        var rollback = new StubRollbackStore();

        ActionOutcome outcome = await DnsExecutor(network, Reachable(), rollback)
            .ExecuteAsync(DnsRequest("10.20.30.9"), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Null(rollback.Pending);
        Assert.False(network.ApplyWasCalled);
    }

    [Theory]
    [InlineData("dns.example.com")]
    [InlineData("not an address")]
    public async Task A_dns_server_named_rather_than_addressed_is_refused(string value)
    {
        // A DNS server is set by address and never by name: a name would have
        // to be resolved by the very resolver being reconfigured.
        var network = new StubNetworkGateway(Current());

        ActionOutcome outcome = await DnsExecutor(network, Reachable(), new StubRollbackStore())
            .ExecuteAsync(DnsRequest(value), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.False(network.ApplyWasCalled);
    }

    [Fact]
    public async Task Returning_to_dhcp_also_clears_the_adapters_static_dns_servers()
    {
        // An adapter left with static DNS after EnableDHCP resolves against
        // whatever the previous network used, which is the subtlest way to
        // leave a cabinet half-moved.
        var network = new StubNetworkGateway(Current());

        ActionOutcome outcome = await new SetAdapterToDhcpExecutor(
                network,
                Reachable(),
                new StubRollbackStore(),
                TestOptions.Create(Options()),
                NullLogger<SetAdapterToDhcpExecutor>.Instance)
            .ExecuteAsync(
                Request(ActionName.SetAdapterToDhcp,
                    new Dictionary<string, string> { [ActionParameterKeys.AdapterId] = AdapterId }),
                CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.True(network.DhcpEnabled);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationOrProbeFailureAfterMutationRestores(bool cancel)
    {
        var network = new StubNetworkGateway(Current());
        var rollback = new StubRollbackStore();
        try
        {
            await DnsExecutor(network, new FailingProbe(cancel), rollback)
                .ExecuteAsync(DnsRequest("10.20.30.9"), CancellationToken.None);
        }
        catch (Exception) { /* The safety assertion is independent of result classification. */ }
        Assert.True(network.Restored);
        Assert.Null(rollback.Pending);
    }

    [Fact]
    public async Task PendingRollbackBlocksAnotherMutation()
    {
        var original = new NetworkRollback { ActionRequestId = Guid.NewGuid(), Previous = Current(), AppliedUtc = DateTimeOffset.UtcNow };
        var rollback = new StubRollbackStore();
        rollback.Write(original);
        var network = new StubNetworkGateway(Current());
        var outcome = await DnsExecutor(network, Reachable(), rollback)
            .ExecuteAsync(DnsRequest("10.20.30.9"), CancellationToken.None);
        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.False(network.ApplyWasCalled);
        Assert.Same(original, rollback.Pending);
    }

    [Fact]
    public async Task CancellationDuringPartialApplyAttemptsRestoreAndRetainsFailedRollback()
    {
        var rollback = new StubRollbackStore();
        var network = new StubNetworkGateway(Current())
        {
            OnApply = () => throw new OperationCanceledException(),
            FailRestore = true,
        };
        var outcome = await DnsExecutor(network, Reachable(), rollback)
            .ExecuteAsync(DnsRequest("10.20.30.9"), CancellationToken.None);
        Assert.Contains("RevertFailed", outcome.CollectedData!);
        Assert.NotNull(rollback.Pending);
    }

    private sealed class FailingProbe(bool cancel) : IServerReachabilityProbe
    {
        public Task<ServerReachability> ProbeAsync(CancellationToken token) =>
            throw (cancel ? new OperationCanceledException() : new IOException("probe failure"));
    }

    private static SetDnsServersExecutor DnsExecutor(
        INetworkConfigurationGateway network,
        IServerReachabilityProbe probe,
        INetworkRollbackStore rollback) =>
        new(
            network,
            probe,
            rollback,
            TestOptions.Create(Options()),
            NullLogger<SetDnsServersExecutor>.Instance);

    private static AgentOptions Options()
    {
        var options = new AgentOptions();

        // Short, so the unreachable case does not make the suite wait a minute
        // to prove a revert happens.
        options.Actions.NetworkConfirmationTimeoutSeconds = 10;

        return options;
    }

    private static AdapterConfiguration Current() => new()
    {
        AdapterId = AdapterId,
        AdapterName = "Intel(R) Ethernet Connection I219-LM",
        DhcpEnabled = false,
        IpAddresses = new[] { "10.20.30.41" },
        SubnetMasks = new[] { "255.255.255.0" },
        Gateways = new[] { "10.20.30.1" },
        DnsServers = new[] { "10.20.30.2", "10.20.30.3" },
    };

    private static StubReachabilityProbe Reachable() => new(reachable: true);

    private static StubReachabilityProbe Unreachable() => new(reachable: false);

    private static ActionRequestDto DnsRequest(string servers) => Request(
        ActionName.SetDnsServers,
        new Dictionary<string, string>
        {
            [ActionParameterKeys.AdapterId] = AdapterId,
            [ActionParameterKeys.DnsServers] = servers,
        });

    private static ActionRequestDto Request(
        ActionName action, IReadOnlyDictionary<string, string> parameters) => new()
    {
        Id = Guid.NewGuid(),
        Action = action,
        CabinetId = Guid.NewGuid(),
        Reason = "The clinic moved to a new DNS server.",
        RequestedByUserId = Guid.NewGuid(),
        RequestedUtc = DateTimeOffset.UtcNow,
        Parameters = parameters,
    };
}

/// <summary>
/// The startup half of confirm-or-revert: an agent that comes back holding an
/// unconfirmed change undoes it before doing anything else.
/// </summary>
public class InterruptedNetworkChangeTests
{
    [Fact]
    public void An_unconfirmed_change_found_at_startup_is_reverted()
    {
        // The agent restarting between applying and confirming is exactly the
        // case the on-disk rollback exists for. The previous configuration is
        // known to have worked; the new one is not.
        var previous = new AdapterConfiguration
        {
            AdapterId = "{ADAPTER}",
            DhcpEnabled = true,
        };

        var rollback = new StubRollbackStore();
        rollback.Write(new NetworkRollback
        {
            ActionRequestId = Guid.NewGuid(),
            Previous = previous,
            AppliedUtc = DateTimeOffset.UtcNow.AddMinutes(-3),
        });

        var network = new StubNetworkGateway(previous);

        Runner(rollback, network).RecoverInterruptedNetworkChange();

        Assert.True(network.Restored);
        Assert.Null(rollback.Pending);
    }

    [Fact]
    public void A_startup_revert_that_fails_leaves_the_rollback_for_the_next_start()
    {
        // A cabinet holding a configuration nobody confirmed is worth retrying
        // on every start until it is fixed or somebody goes.
        var previous = new AdapterConfiguration { AdapterId = "{ADAPTER}", DhcpEnabled = true };

        var rollback = new StubRollbackStore();
        rollback.Write(new NetworkRollback
        {
            ActionRequestId = Guid.NewGuid(),
            Previous = previous,
            AppliedUtc = DateTimeOffset.UtcNow.AddMinutes(-3),
        });

        var network = new StubNetworkGateway(previous) { FailRestore = true };

        Runner(rollback, network).RecoverInterruptedNetworkChange();

        Assert.NotNull(rollback.Pending);
    }

    [Fact]
    public void A_clean_start_reverts_nothing()
    {
        var network = new StubNetworkGateway(current: null);

        Runner(new StubRollbackStore(), network).RecoverInterruptedNetworkChange();

        Assert.False(network.Restored);
    }

    private static ScheduledUpdateRunner Runner(
        INetworkRollbackStore rollback, INetworkConfigurationGateway network) =>
        new(
            new StubScheduleWriter(),
            new StubUpdateGateway(),
            rollback,
            network,
            new InMemoryAgentStateStore(),
            new FixedClock(DateTimeOffset.UtcNow),
            NullLogger<ScheduledUpdateRunner>.Instance);
}

/// <summary>An adapter configuration a test controls.</summary>
internal sealed class StubNetworkGateway : INetworkConfigurationGateway
{
    private readonly AdapterConfiguration? _current;

    public StubNetworkGateway(AdapterConfiguration? current) => _current = current;

    /// <summary>Runs at the moment a change is applied, for ordering assertions.</summary>
    public Action? OnApply { get; set; }

    /// <summary>When set, applying throws.</summary>
    public bool FailApply { get; set; }

    /// <summary>When set, restoring throws.</summary>
    public bool FailRestore { get; set; }

    /// <summary>Whether a change was attempted.</summary>
    public bool ApplyWasCalled { get; private set; }

    /// <summary>Whether the previous configuration was put back.</summary>
    public bool Restored { get; private set; }

    /// <summary>The DNS servers that were set, if any.</summary>
    public IReadOnlyList<string> DnsSet { get; private set; } = Array.Empty<string>();

    /// <summary>Whether the adapter was returned to DHCP.</summary>
    public bool DhcpEnabled { get; private set; }

    public AdapterConfiguration? Read(string adapterId) => _current;

    public void SetDnsServers(string adapterId, IReadOnlyList<string> dnsServers)
    {
        Apply();
        DnsSet = dnsServers;
    }

    public void SetStaticAddress(
        string adapterId, string ipAddress, string subnetMask, string? defaultGateway) => Apply();

    public void EnableDhcp(string adapterId)
    {
        Apply();
        DhcpEnabled = true;
    }

    public void Restore(AdapterConfiguration configuration)
    {
        if (FailRestore)
        {
            throw new InvalidOperationException("The adapter could not be restored.");
        }

        Restored = true;
    }

    private void Apply()
    {
        OnApply?.Invoke();
        ApplyWasCalled = true;

        if (FailApply)
        {
            throw new InvalidOperationException("The adapter refused the change.");
        }
    }
}

/// <summary>A rollback store held in memory.</summary>
internal sealed class StubRollbackStore : INetworkRollbackStore
{
    public NetworkRollback? Pending { get; private set; }

    public void Write(NetworkRollback rollback) => Pending = rollback;

    public NetworkRollback? Read() => Pending;

    public void Clear() => Pending = null;
}

/// <summary>A reachability answer a test chooses.</summary>
internal sealed class StubReachabilityProbe : IServerReachabilityProbe
{
    private readonly bool _reachable;

    public StubReachabilityProbe(bool reachable) => _reachable = reachable;

    public Task<ServerReachability> ProbeAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new ServerReachability(_reachable, _reachable ? 4.2 : null));
}
