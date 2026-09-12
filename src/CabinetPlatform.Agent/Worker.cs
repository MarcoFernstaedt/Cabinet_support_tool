using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent;

/// <summary>
/// The agent's main loop: collect, deliver, poll for work, wait, repeat.
/// </summary>
/// <remarks>
/// <para>
/// Everything about the timing here is shaped by the fact that a clinic has
/// many cabinets and the estate has many clinics. The interval is jittered so a
/// site's cabinets do not check in in lockstep after a shared power event, and
/// failures back off with a ceiling so a server that is already struggling is
/// not held down by its own fleet.
/// </para>
/// <para>
/// Until the server approves this cabinet, each tick sends identity only and
/// collects nothing.
/// </para>
/// </remarks>
public sealed class Worker : BackgroundService
{
    /// <summary>
    /// Buffered payloads flushed per tick. Bounded so that catching up after a
    /// long outage does not itself become a burst.
    /// </summary>
    private const int MaximumBufferedPerTick = 5;

    private readonly CheckInBuilder _checkInBuilder;
    private readonly IServerClient _client;
    private readonly IPayloadBuffer _buffer;
    private readonly RegistrationService _registration;
    private readonly ActionDispatcher _dispatcher;
    private readonly ScheduledUpdateRunner _scheduledUpdates;
    private readonly IAgentStateStore _stateStore;
    private readonly IOptions<AgentOptions> _options;
    private readonly ILogger<Worker> _logger;
    private readonly Random _random = new();

    private int _consecutiveFailures;
    private DateTimeOffset? _lastFullCheckInUtc;

    public Worker(
        CheckInBuilder checkInBuilder,
        IServerClient client,
        IPayloadBuffer buffer,
        RegistrationService registration,
        ActionDispatcher dispatcher,
        ScheduledUpdateRunner scheduledUpdates,
        IAgentStateStore stateStore,
        IOptions<AgentOptions> options,
        ILogger<Worker> logger)
    {
        _checkInBuilder = checkInBuilder;
        _client = client;
        _buffer = buffer;
        _registration = registration;
        _dispatcher = dispatcher;
        _scheduledUpdates = scheduledUpdates;
        _stateStore = stateStore;
        _options = options;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "Cabinet agent {AgentVersion} starting. Server {ServerBaseUrl}, check-in every {IntervalSeconds}s " +
            "(jittered {JitterPercent}%).",
            CheckInBuilder.AgentVersion,
            _options.Value.ServerBaseUrl,
            _options.Value.CheckInIntervalSeconds,
            _options.Value.CheckInJitterPercent);

        // A network change applied but never confirmed is undone before
        // anything else happens. The agent restarting between applying and
        // confirming is exactly the case confirm-or-revert exists for, and the
        // previous configuration is the one known to have worked.
        _scheduledUpdates.RecoverInterruptedNetworkChange();

        // Anything that was running when the agent last stopped is reported as
        // unknown before any new work is taken on, and is never resumed.
        await ReportInterruptedActionAsync(stoppingToken).ConfigureAwait(false);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                // The loop is the last line of defence. It must survive
                // anything a tick can throw, or a cabinet goes quiet until
                // somebody notices and restarts the service.
                _consecutiveFailures++;
                _logger.LogError(e, "The check-in tick failed unexpectedly.");
            }

            var delay = NextDelay();

            try
            {
                await Task.Delay(delay, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        _logger.LogInformation("Cabinet agent stopping.");
    }

    private async Task TickAsync(CancellationToken cancellationToken)
    {
        var approved = await _registration.EnsureRegisteredAsync(cancellationToken).ConfigureAwait(false);

        if (!approved)
        {
            await SendIdentityOnlyAsync(cancellationToken).ConfigureAwait(false);
            return;
        }

        // The slow tier is due on its own schedule, and on the first tick after
        // a start: a cabinet that has just rebooted is exactly the one whose
        // inventory is most likely to have changed.
        // A scheduled install whose instant has arrived runs before the
        // payload is built, so the same tick reports what it did rather than
        // leaving the outcome until the next one.
        _scheduledUpdates.RunDueInstall(cancellationToken);

        CheckInTier tier = IsFullCheckInDue() ? CheckInTier.Full : CheckInTier.Heartbeat;

        // The current payload goes first: the freshest picture of the cabinet
        // is the most useful thing the server can have.
        var payload = await _checkInBuilder.BuildAsync(tier, cancellationToken).ConfigureAwait(false);
        var result = await _client.CheckInAsync(payload, tier, cancellationToken).ConfigureAwait(false);

        if (result.Outcome == CheckInOutcome.Accepted && tier == CheckInTier.Full)
        {
            _lastFullCheckInUtc = DateTimeOffset.UtcNow;
        }

        switch (result.Outcome)
        {
            case CheckInOutcome.Accepted:
                if (_consecutiveFailures > 0)
                {
                    _logger.LogInformation(
                        "The server is reachable again after {FailureCount} failed attempt(s).",
                        _consecutiveFailures);
                }

                _consecutiveFailures = 0;

                if (result.CabinetId is { } cabinetId)
                {
                    _registration.RecordApproval(cabinetId);
                }

                // Cleared only once the server has taken them. An outcome lost
                // to an outage would leave the fleet believing this cabinet is
                // patched when it is not.
                if (payload.UpdateInstallOutcomes is { Count: > 0 } reported)
                {
                    _scheduledUpdates.ClearReportedOutcomes(reported);
                }

                await FlushBufferAsync(cancellationToken).ConfigureAwait(false);
                await PollAndRunActionsAsync(cancellationToken).ConfigureAwait(false);
                break;

            case CheckInOutcome.NotApproved:
                // Approval was revoked, or a race with the server's own state.
                // Nothing diagnostic is sent until it is approved again.
                _consecutiveFailures = 0;
                _logger.LogWarning("The server reports this cabinet is not approved. Reporting identity only.");
                break;

            case CheckInOutcome.NotRegistered:
                _consecutiveFailures = 0;
                _registration.RecordNotRegistered();
                break;

            case CheckInOutcome.Rejected:
                // Retrying an identical payload cannot succeed, so it is
                // dropped rather than spooled forever behind everything else.
                _consecutiveFailures = 0;
                _logger.LogError(
                    "The server rejected this check-in as malformed and it has been discarded. {Detail}",
                    result.Detail);
                break;

            case CheckInOutcome.Failed:
            default:
                _consecutiveFailures++;
                _logger.LogWarning(
                    "Check-in {FailureCount} failed; the payload has been spooled for retry. {Detail}",
                    _consecutiveFailures,
                    result.Detail);

                _buffer.Enqueue(payload, tier);
                break;
        }
    }

    /// <summary>
    /// Sends the identity-only payload used before approval.
    /// </summary>
    /// <remarks>
    /// It is never spooled on failure. A queue of identity payloads has no
    /// value: only the most recent one says anything, and the next tick will
    /// send a fresher one anyway.
    /// </remarks>
    private async Task SendIdentityOnlyAsync(CancellationToken cancellationToken)
    {
        var payload = _checkInBuilder.BuildIdentityOnly();
        var result = await _client
            .CheckInAsync(payload, CheckInTier.Heartbeat, cancellationToken)
            .ConfigureAwait(false);

        if (result.Outcome == CheckInOutcome.Accepted && result.CabinetId is { } cabinetId)
        {
            _registration.RecordApproval(cabinetId);
            _consecutiveFailures = 0;
            return;
        }

        if (result.Outcome == CheckInOutcome.Failed)
        {
            _consecutiveFailures++;
            return;
        }

        _consecutiveFailures = 0;
        _logger.LogDebug("Waiting for approval; the server responded {Outcome}.", result.Outcome);
    }

    /// <summary>
    /// Delivers spooled payloads, oldest first.
    /// </summary>
    private async Task FlushBufferAsync(CancellationToken cancellationToken)
    {
        var buffered = _buffer.PeekOldest(MaximumBufferedPerTick);
        if (buffered.Count == 0)
        {
            return;
        }

        _logger.LogInformation(
            "Delivering {BufferedCount} spooled payload(s) of {TotalCount} held.",
            buffered.Count,
            _buffer.Count);

        foreach (var item in buffered)
        {
            cancellationToken.ThrowIfCancellationRequested();

            // A spooled payload is replayed on the tier it was collected for,
            // so an inventory sample delivered late is still stored as one.
            var result = await _client
                .CheckInAsync(item.Payload, item.Tier, cancellationToken)
                .ConfigureAwait(false);

            switch (result.Outcome)
            {
                case CheckInOutcome.Accepted:
                case CheckInOutcome.Rejected:
                    // Delivered, or permanently undeliverable. Either way it
                    // should not be retried.
                    _buffer.Remove(item.Id);
                    break;

                default:
                    // The server went away again mid-flush. Everything still
                    // spooled stays spooled, in order.
                    _logger.LogDebug("Stopping the flush; the server responded {Outcome}.", result.Outcome);
                    return;
            }
        }
    }

    /// <summary>
    /// Polls for approved actions and runs them one at a time.
    /// </summary>
    /// <remarks>
    /// Polling rather than a push. SignalR would cut the latency, but it is a
    /// later optimisation and not what this build needs to be correct.
    /// </remarks>
    private async Task PollAndRunActionsAsync(CancellationToken cancellationToken)
    {
        var cabinetId = _stateStore.Load().CabinetId;
        if (cabinetId is null)
        {
            return;
        }

        var actions = await _client.GetPendingActionsAsync(cabinetId.Value, cancellationToken).ConfigureAwait(false);
        if (actions.Count == 0)
        {
            return;
        }

        _logger.LogInformation("The server has {ActionCount} approved action(s) for this cabinet.", actions.Count);

        foreach (var action in actions)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var result = await _dispatcher.DispatchAsync(action, cancellationToken).ConfigureAwait(false);
            await ReportResultAsync(result, cancellationToken).ConfigureAwait(false);

            // A reboot ends the tick: anything after it would be running
            // against a machine that is on its way down.
            if (action.Action == ActionName.RebootMachine && result.Status == ActionStatus.Succeeded)
            {
                _logger.LogInformation("A restart is pending; no further actions will run this tick.");
                return;
            }
        }
    }

    private async Task ReportInterruptedActionAsync(CancellationToken cancellationToken)
    {
        var interrupted = _dispatcher.TakeInterruptedActionResult();
        if (interrupted is null)
        {
            return;
        }

        await ReportResultAsync(interrupted, cancellationToken).ConfigureAwait(false);
    }

    private async Task ReportResultAsync(ActionResultDto result, CancellationToken cancellationToken)
    {
        var reported = await _client.ReportActionResultAsync(result, cancellationToken).ConfigureAwait(false);

        if (!reported)
        {
            // The action ran; only the report failed. It is logged locally so
            // the outcome is not lost from the cabinet's own record.
            _logger.LogWarning(
                "Action {RequestId} finished as {Status} but the result could not be reported to the server. " +
                "Output: {Output}",
                result.RequestId,
                result.Status,
                result.Output);
        }
    }

    /// <summary>
    /// Whether the slow tier is due.
    /// </summary>
    /// <remarks>
    /// Inventory and SMART are collected every few hours, not every few
    /// minutes. SMART is always stored when it is collected — it is the
    /// failure-prediction series and a gap in it is a gap in the prediction —
    /// while inventory is stored only when it has actually changed, so a full
    /// check-in on an untouched cabinet costs one timestamp.
    /// </remarks>
    private bool IsFullCheckInDue()
    {
        if (_lastFullCheckInUtc is not { } last)
        {
            return true;
        }

        return DateTimeOffset.UtcNow - last >=
               TimeSpan.FromSeconds(Math.Max(60, _options.Value.FullCheckInIntervalSeconds));
    }

    private TimeSpan NextDelay()
    {
        if (_consecutiveFailures == 0)
        {
            return CheckInSchedule.NextInterval(_options.Value, _random.NextDouble());
        }

        var backoff = CheckInSchedule.BackoffDelay(
            _options.Value.Backoff,
            _consecutiveFailures,
            _random.NextDouble());

        _logger.LogDebug(
            "Backing off {DelaySeconds:F0}s after {FailureCount} consecutive failure(s).",
            backoff.TotalSeconds,
            _consecutiveFailures);

        return backoff;
    }
}
