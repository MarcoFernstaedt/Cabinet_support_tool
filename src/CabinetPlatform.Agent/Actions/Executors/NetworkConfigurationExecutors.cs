using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Shared confirm-or-revert behaviour for the three network configuration
/// changes.
/// </summary>
/// <remarks>
/// <para>
/// Every one of these can strand a cabinet. A wrong DNS server, a static
/// address on the wrong subnet, a return to DHCP where there is no DHCP server:
/// each leaves a machine that is running perfectly and cannot be reached by
/// anybody, and the only remaining fix is somebody driving to the clinic.
/// </para>
/// <para>
/// So the sequence is fixed and is the same for all three. Read the current
/// configuration. Write it to disk — to disk, because the case that matters is
/// a restart in the middle. Apply the change. Wait for the cabinet to reach the
/// server. If it does, confirm and delete the rollback. If it does not, put the
/// old configuration back.
/// </para>
/// <para>
/// The rollback file is also checked at startup, which is what covers the
/// mid-change restart: an agent that comes back up holding an unconfirmed
/// rollback reverts before it does anything else.
/// </para>
/// </remarks>
public abstract class NetworkConfigurationExecutorBase : IActionExecutor
{
    private readonly INetworkConfigurationGateway _network;
    private readonly IServerReachabilityProbe _probe;
    private readonly INetworkRollbackStore _rollback;
    private readonly ActionOptions _options;

    /// <summary>Creates the executor.</summary>
    /// <param name="network">Changes adapter configuration.</param>
    /// <param name="probe">Asks whether the server is reachable.</param>
    /// <param name="rollback">Holds the previous configuration on disk.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    protected NetworkConfigurationExecutorBase(
        INetworkConfigurationGateway network,
        IServerReachabilityProbe probe,
        INetworkRollbackStore rollback,
        IOptions<AgentOptions> options,
        ILogger logger)
    {
        _network = network;
        _probe = probe;
        _rollback = rollback;
        _options = options.Value.Actions;
        Logger = logger;
    }

    /// <summary>Diagnostic log.</summary>
    protected ILogger Logger { get; }

    /// <inheritdoc />
    public abstract ActionName Action { get; }

    /// <summary>The parameter keys this action defines.</summary>
    protected abstract IReadOnlyList<string> PermittedParameterKeys { get; }

    /// <summary>Applies the change. The adapter has already been resolved.</summary>
    /// <param name="request">The request, for this action's own parameters.</param>
    /// <param name="adapterId">The adapter's settings identifier.</param>
    /// <param name="network">The gateway to apply through.</param>
    /// <param name="applied">One line describing what was applied.</param>
    /// <param name="failureReason">Why the change could not be attempted.</param>
    protected abstract bool TryApply(
        ActionRequestDto request,
        string adapterId,
        INetworkConfigurationGateway network,
        out string applied,
        out string failureReason);

    /// <inheritdoc />
    public async Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, PermittedParameterKeys, out string unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.AdapterId, out string adapterId, out string missing))
        {
            return ActionOutcome.Denied(missing);
        }

        AdapterConfiguration? previous;

        try
        {
            previous = _network.Read(adapterId);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Logger.LogWarning(e, "Adapter '{AdapterId}' could not be read.", adapterId);
            return ActionOutcome.Failed($"Adapter '{adapterId}' could not be read. {e.Message}");
        }

        if (previous is null)
        {
            return ActionOutcome.Denied(
                $"No network adapter with settings id '{adapterId}' is present on this cabinet.");
        }

        var timeout = TimeSpan.FromSeconds(_options.NetworkConfirmationTimeoutSeconds);

        // Written before anything is applied. A rollback recorded after the
        // change is a rollback that is missing in exactly the case it exists
        // for: the machine losing power mid-change.
        _rollback.Write(new NetworkRollback
        {
            ActionRequestId = request.Id,
            Previous = previous,
            AppliedUtc = DateTimeOffset.UtcNow,
        });

        string applied;

        try
        {
            if (!TryApply(request, adapterId, _network, out applied, out string applyFailure))
            {
                _rollback.Clear();
                return ActionOutcome.Denied(applyFailure);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Logger.LogWarning(e, "The change to adapter '{AdapterId}' could not be applied.", adapterId);

            // Nothing was applied, so there is nothing to revert — but the
            // rollback is cleared anyway, so a later restart does not find a
            // stale one and undo a configuration nobody changed.
            _rollback.Clear();

            return Failed(previous, timeout, $"The change could not be applied. {e.Message}");
        }

        Logger.LogInformation(
            "Applied a network change to adapter '{AdapterId}'; waiting up to {TimeoutSeconds}s for " +
            "this cabinet to reach the server before keeping it.",
            adapterId,
            timeout.TotalSeconds);

        bool reachable = await WaitForServerAsync(timeout, cancellationToken).ConfigureAwait(false);

        if (reachable)
        {
            _rollback.Clear();

            Logger.LogInformation(
                "The cabinet reached the server after the change to '{AdapterId}'. The change stands.",
                adapterId);

            return Collected(new NetworkChangeResultDto
            {
                AdapterId = adapterId,
                AdapterName = previous.AdapterName,
                Outcome = NetworkChangeOutcome.Confirmed,
                PreviousConfiguration = Describe(previous),
                AppliedConfiguration = applied,
                ConfirmationTimeoutSeconds = (int)timeout.TotalSeconds,
            },
            $"The change was applied to '{previous.AdapterName ?? adapterId}' and the cabinet still " +
            "reaches the server, so it has been kept. " + applied);
        }

        Logger.LogWarning(
            "The cabinet did not reach the server within {TimeoutSeconds}s of the change to " +
            "'{AdapterId}'. Reverting.",
            timeout.TotalSeconds,
            adapterId);

        return Revert(previous, applied, timeout, adapterId);
    }

    /// <summary>
    /// Puts the previous configuration back and reports which of the two
    /// unhappy endings happened.
    /// </summary>
    /// <remarks>
    /// A failed revert is reported as itself rather than folded into a generic
    /// failure. It is the one state that needs a person now: the cabinet is
    /// holding a configuration nobody wanted and cannot be reached to change it.
    /// </remarks>
    private ActionOutcome Revert(
        AdapterConfiguration previous, string applied, TimeSpan timeout, string adapterId)
    {
        try
        {
            _network.Restore(previous);
            _rollback.Clear();

            return Collected(new NetworkChangeResultDto
            {
                AdapterId = adapterId,
                AdapterName = previous.AdapterName,
                Outcome = NetworkChangeOutcome.Reverted,
                PreviousConfiguration = Describe(previous),
                AppliedConfiguration = applied,
                ConfirmationTimeoutSeconds = (int)timeout.TotalSeconds,
            },
            $"The change was applied to '{previous.AdapterName ?? adapterId}' but the cabinet could " +
            $"not reach the server within {timeout.TotalSeconds:F0} seconds, so the previous " +
            "configuration was put back. The cabinet is as it was.");
        }
        catch (Exception e)
        {
            Logger.LogError(
                e,
                "The change to '{AdapterId}' could not be reverted. This cabinet may now be " +
                "unreachable.",
                adapterId);

            return Collected(new NetworkChangeResultDto
            {
                AdapterId = adapterId,
                AdapterName = previous.AdapterName,
                Outcome = NetworkChangeOutcome.RevertFailed,
                PreviousConfiguration = Describe(previous),
                AppliedConfiguration = applied,
                ConfirmationTimeoutSeconds = (int)timeout.TotalSeconds,
            },
            $"The change was applied to '{previous.AdapterName ?? adapterId}', the cabinet could not " +
            "reach the server afterwards, and the previous configuration could NOT be put back. " +
            $"This cabinet needs attention on site. {e.Message}");
        }
    }

    private async Task<bool> WaitForServerAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        // Polled rather than probed once. An adapter that has just been
        // reconfigured needs a moment for DHCP, ARP and DNS to settle, and
        // reverting a perfectly good change because the first probe was half a
        // second early would be its own kind of outage.
        var deadline = DateTimeOffset.UtcNow + timeout;
        var interval = TimeSpan.FromSeconds(5);

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();

            ServerReachability reachability =
                await _probe.ProbeAsync(cancellationToken).ConfigureAwait(false);

            if (reachability.Reachable == true)
            {
                return true;
            }

            TimeSpan remaining = deadline - DateTimeOffset.UtcNow;

            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            await Task.Delay(
                remaining < interval ? remaining : interval, cancellationToken).ConfigureAwait(false);
        }

        return false;
    }

    private static ActionOutcome Failed(
        AdapterConfiguration previous, TimeSpan timeout, string message) =>
        ActionOutcome.Failed(message);

    private static ActionOutcome Collected(NetworkChangeResultDto result, string summary) =>
        ActionOutcome.Collected(summary, JsonSerializer.Serialize(result, AgentJson.SerializerOptions));

    /// <summary>Renders a configuration as one readable line.</summary>
    /// <param name="configuration">The configuration.</param>
    internal static string Describe(AdapterConfiguration configuration)
    {
        string addressing = configuration.DhcpEnabled
            ? "DHCP"
            : $"static {string.Join(", ", configuration.IpAddresses)}" +
              (configuration.SubnetMasks.Count > 0
                  ? $" mask {string.Join(", ", configuration.SubnetMasks)}"
                  : string.Empty) +
              (configuration.Gateways.Count > 0
                  ? $" gateway {string.Join(", ", configuration.Gateways)}"
                  : string.Empty);

        string dns = configuration.DnsServers is null
            ? "DNS inherited from the machine"
            : configuration.DnsServers.Count == 0
                ? "no DNS servers"
                : $"DNS {string.Join(", ", configuration.DnsServers)}";

        return $"{addressing}; {dns}";
    }
}

/// <summary>Replaces an adapter's DNS servers, under confirm-or-revert.</summary>
public sealed class SetDnsServersExecutor : NetworkConfigurationExecutorBase
{
    /// <summary>Creates the executor.</summary>
    /// <param name="network">Changes adapter configuration.</param>
    /// <param name="probe">Asks whether the server is reachable.</param>
    /// <param name="rollback">Holds the previous configuration on disk.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public SetDnsServersExecutor(
        INetworkConfigurationGateway network,
        IServerReachabilityProbe probe,
        INetworkRollbackStore rollback,
        IOptions<AgentOptions> options,
        ILogger<SetDnsServersExecutor> logger)
        : base(network, probe, rollback, options, logger)
    {
    }

    /// <inheritdoc />
    public override ActionName Action => ActionName.SetDnsServers;

    /// <inheritdoc />
    protected override IReadOnlyList<string> PermittedParameterKeys { get; } = new[]
    {
        ActionParameterKeys.AdapterId,
        ActionParameterKeys.DnsServers,
    };

    /// <inheritdoc />
    protected override bool TryApply(
        ActionRequestDto request,
        string adapterId,
        INetworkConfigurationGateway network,
        out string applied,
        out string failureReason)
    {
        applied = string.Empty;

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.DnsServers, out string raw, out failureReason))
        {
            return false;
        }

        string[] servers = raw.Split(
            ',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        // Parsed as addresses, not accepted as text. A DNS server is set by
        // address and never by name: a name would have to be resolved by the
        // very resolver being reconfigured.
        foreach (string server in servers)
        {
            if (!System.Net.IPAddress.TryParse(server, out _))
            {
                failureReason = $"'{server}' is not an IP address.";
                return false;
            }
        }

        if (servers.Length == 0)
        {
            failureReason = "No DNS servers were supplied.";
            return false;
        }

        network.SetDnsServers(adapterId, servers);

        applied = $"DNS servers set to {string.Join(", ", servers)}.";
        failureReason = string.Empty;
        return true;
    }
}

/// <summary>Gives an adapter a static address, under confirm-or-revert.</summary>
public sealed class SetStaticIpAddressExecutor : NetworkConfigurationExecutorBase
{
    /// <summary>Creates the executor.</summary>
    /// <param name="network">Changes adapter configuration.</param>
    /// <param name="probe">Asks whether the server is reachable.</param>
    /// <param name="rollback">Holds the previous configuration on disk.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public SetStaticIpAddressExecutor(
        INetworkConfigurationGateway network,
        IServerReachabilityProbe probe,
        INetworkRollbackStore rollback,
        IOptions<AgentOptions> options,
        ILogger<SetStaticIpAddressExecutor> logger)
        : base(network, probe, rollback, options, logger)
    {
    }

    /// <inheritdoc />
    public override ActionName Action => ActionName.SetStaticIpAddress;

    /// <inheritdoc />
    protected override IReadOnlyList<string> PermittedParameterKeys { get; } = new[]
    {
        ActionParameterKeys.AdapterId,
        ActionParameterKeys.IpAddress,
        ActionParameterKeys.SubnetMask,
        ActionParameterKeys.DefaultGateway,
    };

    /// <inheritdoc />
    protected override bool TryApply(
        ActionRequestDto request,
        string adapterId,
        INetworkConfigurationGateway network,
        out string applied,
        out string failureReason)
    {
        applied = string.Empty;

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.IpAddress, out string address, out failureReason) ||
            !ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.SubnetMask, out string mask, out failureReason))
        {
            return false;
        }

        if (!System.Net.IPAddress.TryParse(address, out _) ||
            !System.Net.IPAddress.TryParse(mask, out _))
        {
            failureReason = "The address and mask must both be IPv4 addresses.";
            return false;
        }

        string? gateway = null;

        if (request.Parameters.TryGetValue(ActionParameterKeys.DefaultGateway, out string? rawGateway) &&
            !string.IsNullOrWhiteSpace(rawGateway))
        {
            if (!System.Net.IPAddress.TryParse(rawGateway.Trim(), out _))
            {
                failureReason = $"'{rawGateway.Trim()}' is not an IPv4 address.";
                return false;
            }

            gateway = rawGateway.Trim();
        }

        network.SetStaticAddress(adapterId, address, mask, gateway);

        applied = gateway is null
            ? $"Static address {address} mask {mask}, gateway unchanged."
            : $"Static address {address} mask {mask} gateway {gateway}.";

        failureReason = string.Empty;
        return true;
    }
}

/// <summary>Returns an adapter to DHCP, under confirm-or-revert.</summary>
public sealed class SetAdapterToDhcpExecutor : NetworkConfigurationExecutorBase
{
    /// <summary>Creates the executor.</summary>
    /// <param name="network">Changes adapter configuration.</param>
    /// <param name="probe">Asks whether the server is reachable.</param>
    /// <param name="rollback">Holds the previous configuration on disk.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public SetAdapterToDhcpExecutor(
        INetworkConfigurationGateway network,
        IServerReachabilityProbe probe,
        INetworkRollbackStore rollback,
        IOptions<AgentOptions> options,
        ILogger<SetAdapterToDhcpExecutor> logger)
        : base(network, probe, rollback, options, logger)
    {
    }

    /// <inheritdoc />
    public override ActionName Action => ActionName.SetAdapterToDhcp;

    /// <inheritdoc />
    protected override IReadOnlyList<string> PermittedParameterKeys { get; } = new[]
    {
        ActionParameterKeys.AdapterId,
    };

    /// <inheritdoc />
    protected override bool TryApply(
        ActionRequestDto request,
        string adapterId,
        INetworkConfigurationGateway network,
        out string applied,
        out string failureReason)
    {
        network.EnableDhcp(adapterId);

        applied = "Returned to DHCP, with the adapter's static DNS servers cleared.";
        failureReason = string.Empty;
        return true;
    }
}
