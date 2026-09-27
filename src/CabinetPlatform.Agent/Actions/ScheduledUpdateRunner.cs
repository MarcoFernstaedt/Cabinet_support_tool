using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Configuration;
using Microsoft.Extensions.Options;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Actions;

/// <summary>
/// Performs a scheduled update install when its instant arrives, and recovers
/// an unconfirmed network change after a restart.
/// </summary>
/// <remarks>
/// <para>
/// Both of these exist because a cabinet restarts. An install scheduled for
/// 02:00 has to happen whether or not the agent has been running continuously
/// since it was scheduled, and a network change applied a moment before the
/// power went out has to be undone rather than left in force. Neither can be
/// held in memory.
/// </para>
/// <para>
/// The runner is called from the agent's loop rather than being a timer of its
/// own: the loop already wakes on a known cadence, and a second scheduler would
/// be a second thing to reason about for no gain.
/// </para>
/// </remarks>
public sealed class ScheduledUpdateRunner
{
    private readonly ActionOptions _options;
    private readonly IScheduledUpdateWriter _schedule;
    private readonly IWindowsUpdateGateway _updates;
    private readonly INetworkRollbackStore _rollback;
    private readonly INetworkConfigurationGateway _network;
    private readonly IAgentStateStore _stateStore;
    private readonly IClock _clock;
    private readonly ILogger<ScheduledUpdateRunner> _logger;

    /// <summary>Creates the runner.</summary>
    /// <param name="schedule">Holds what the cabinet is due to install.</param>
    /// <param name="updates">The Windows Update Agent.</param>
    /// <param name="rollback">Holds an unconfirmed network change.</param>
    /// <param name="network">Restores a network configuration.</param>
    /// <param name="stateStore">Queues outcomes for the next check-in.</param>
    /// <param name="clock">The current instant.</param>
    /// <param name="logger">Diagnostic log.</param>
    public ScheduledUpdateRunner(
        IScheduledUpdateWriter schedule,
        IWindowsUpdateGateway updates,
        INetworkRollbackStore rollback,
        INetworkConfigurationGateway network,
        IAgentStateStore stateStore,
        IClock clock,
        ILogger<ScheduledUpdateRunner> logger,
        IOptions<AgentOptions>? options = null)
    {
        _options = options?.Value.Actions ?? new ActionOptions();
        _schedule = schedule;
        _updates = updates;
        _rollback = rollback;
        _network = network;
        _stateStore = stateStore;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>
    /// Undoes a network change that was applied but never confirmed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Called once at startup, before anything else. An agent that comes back
    /// holding an unconfirmed rollback restarted between applying a change and
    /// proving the cabinet could still be reached — so the change is undone
    /// rather than kept. The previous configuration is known to have worked;
    /// the new one is not.
    /// </para>
    /// <para>
    /// The cabinet reaching the server right now is not evidence the change was
    /// good, because the agent may be talking over a different adapter than the
    /// one that was changed. Reverting is the answer that cannot strand anybody.
    /// </para>
    /// </remarks>
    public void RecoverInterruptedNetworkChange()
    {
        if (!_options.MaintenanceEnabled)
        {
            if (_rollback.Read() is not null)
                _logger.LogWarning("Non-maintenance mode suspends an unconfirmed network rollback. " +
                    "The rollback record is retained; on-site attention is required.");
            return;
        }

        NetworkRollback? pending = _rollback.Read();

        if (pending is null)
        {
            return;
        }

        _logger.LogWarning(
            "A network change to adapter '{AdapterId}', applied at {AppliedUtc:O} under action " +
            "{ActionRequestId}, was never confirmed before this agent restarted. Reverting it.",
            pending.Previous.AdapterId,
            pending.AppliedUtc,
            pending.ActionRequestId);

        try
        {
            _network.Restore(pending.Previous);
            _rollback.Clear();

            _logger.LogInformation(
                "The previous configuration of adapter '{AdapterId}' has been restored.",
                pending.Previous.AdapterId);
        }
        catch (Exception e)
        {
            // The file is left in place deliberately, so the next start tries
            // again. A cabinet holding a configuration nobody confirmed is
            // worth retrying on every start until it is fixed or somebody goes.
            _logger.LogError(
                e,
                "The previous configuration of adapter '{AdapterId}' could NOT be restored. This " +
                "cabinet may be holding a network configuration nobody confirmed, and needs " +
                "attention on site.",
                pending.Previous.AdapterId);
        }
    }

    /// <summary>
    /// Runs the scheduled install if its instant has arrived.
    /// </summary>
    /// <remarks>
    /// The comparison is between two UTC instants, which is what makes it
    /// correct across a daylight-saving transition: the instant that was agreed
    /// does not move when the cabinet's offset does.
    /// </remarks>
    /// <param name="cancellationToken">Cancels the install.</param>
    public void RunDueInstall(CancellationToken cancellationToken)
    {
        if (!_options.MaintenanceEnabled)
        {
            _logger.LogInformation("Non-maintenance mode suspends scheduled installs; persisted schedules are retained.");
            return;
        }

        ScheduledUpdateInstall? due = _schedule.Read();

        if (due is null || due.ScheduledForUtc > _clock.UtcNow)
        {
            return;
        }

        _logger.LogInformation(
            "The scheduled install of {UpdateCount} update(s), due at {ScheduledUtc:O}, is starting.",
            due.UpdateIds.Count,
            due.ScheduledForUtc);

        // Cleared before the install rather than after. An install that
        // restarts the machine partway would otherwise be found due again on
        // the next start and run a second time, which on a cabinet is how one
        // approved change becomes two.
        _schedule.Cancel();

        UpdateInstallOutcome outcome;

        try
        {
            outcome = _updates.InstallUpdates(due.UpdateIds, cancellationToken) with
            {
                ActionRequestId = due.ActionRequestId,
                CompletedUtc = _clock.UtcNow,
            };
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _logger.LogError(e, "The scheduled update install failed.");

            // Reported as a failure per update rather than dropped. The fleet
            // has to learn that this cabinet did not get patched, and silence
            // reads as success.
            outcome = new UpdateInstallOutcome
            {
                ActionRequestId = due.ActionRequestId,
                CompletedUtc = _clock.UtcNow,
                Results = due.UpdateIds
                    .Select(id => new UpdateInstallResult
                    {
                        UpdateId = id,
                        ResultCode = UpdateResultCode.Failed,
                    })
                    .ToList(),
                RebootRequired = null,
            };
        }

        UpdateOutcomeQueue.Enqueue(_stateStore, outcome);

        _logger.LogInformation(
            "The scheduled install finished; its outcome is queued for the next check-in.");
    }

    /// <summary>Outcomes waiting to be reported.</summary>
    public IReadOnlyList<UpdateInstallOutcome> PendingOutcomes => _stateStore.Load().PendingUpdateOutcomes;

    /// <summary>Clears the outcomes a check-in has just carried.</summary>
    /// <param name="reported">The outcomes the server accepted.</param>
    public void ClearReportedOutcomes(IReadOnlyList<UpdateInstallOutcome> reported) =>
        UpdateOutcomeQueue.Clear(_stateStore, reported);
}
