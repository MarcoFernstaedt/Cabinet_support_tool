using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions;

/// <summary>
/// Runs approved actions, one at a time, under a timeout, and journals what was
/// in flight.
/// </summary>
/// <remarks>
/// Every decision this class makes leans towards doing less. An action it does
/// not recognise is denied. An action whose parameters do not validate is
/// denied. An action that was running when the agent stopped is never resumed.
/// </remarks>
public sealed class ActionDispatcher
{
    private readonly ActionExecutorRegistry _registry;
    private readonly IAgentStateStore _stateStore;
    private readonly IClock _clock;
    private readonly ActionOptions _options;
    private readonly ILogger<ActionDispatcher> _logger;

    public ActionDispatcher(
        ActionExecutorRegistry registry,
        IAgentStateStore stateStore,
        IClock clock,
        IOptions<AgentOptions> options,
        ILogger<ActionDispatcher> logger)
    {
        _registry = registry;
        _stateStore = stateStore;
        _clock = clock;
        _options = options.Value.Actions;
        _logger = logger;
    }

    /// <summary>
    /// Reports an action that was in flight when the agent last stopped.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The agent cannot know what happened. A reboot may have completed, or the
    /// machine may have lost power a moment before the service stopped; a
    /// service restart may have half-finished. Re-running it would be guessing
    /// with a cabinet that dispenses controlled substances, and reporting
    /// success or failure would be asserting something unknown into a DEA audit
    /// trail.
    /// </para>
    /// <para>
    /// So it reports <see cref="ActionStatus.UnknownResult"/>, clears the
    /// journal, and leaves the decision to a human. This is called once at
    /// startup and never resumes anything.
    /// </para>
    /// </remarks>
    /// <returns>The result to send, or null when nothing was in flight.</returns>
    public ActionResultDto? TakeInterruptedActionResult()
    {
        var inFlight = _stateStore.Load().InFlightAction;
        if (inFlight is null)
        {
            return null;
        }

        _logger.LogWarning(
            "Action {RequestId} ({Action}) was in flight when the agent last stopped, started at {StartedUtc}. " +
            "It will not be resumed or retried; the server is told the result is unknown.",
            inFlight.RequestId,
            inFlight.Action,
            inFlight.StartedUtc);

        var result = new ActionResultDto
        {
            RequestId = inFlight.RequestId,
            Status = ActionStatus.UnknownResult,
            CompletedAtUtc = _clock.UtcNow,
            Output =
                $"The agent restarted while this action was running (started {inFlight.StartedUtc:O}). " +
                "It was not resumed or retried. The cabinet's current state should be confirmed before " +
                "the action is requested again.",
        };
        PersistResult(inFlight.Action, result);
        return result;
    }

    /// <summary>
    /// How many completed requests the agent remembers.
    /// </summary>
    /// <remarks>
    /// The duplicate window that matters is minutes, not days: a repeat arrives
    /// because a result report was lost or a poll raced one, and the server
    /// stops offering an action once it has an outcome. A couple of hundred
    /// entries covers a long outage's worth of catch-up without turning the
    /// state file into a history.
    /// </remarks>
    public const int RememberedActionCount = 200;

    /// <summary>Validates, journals, runs and reports one action.</summary>
    /// <param name="request">The action to carry out.</param>
    /// <param name="cancellationToken">Cancels the action.</param>
    public async Task<ActionResultDto> DispatchAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        // Idempotency first, before the catalog and before validation. A
        // request this agent has already carried out is answered with what it
        // answered last time, whatever that was — a second reboot because the
        // first acknowledgement was lost is exactly the failure this prevents.
        CompletedAction? already = _stateStore.Load().CompletedActions
            .FirstOrDefault(c => c.RequestId == request.Id);

        if (already is not null)
        {
            _logger.LogInformation(
                "Action {RequestId} ({Action}) has already been carried out; replaying its result of " +
                "{Status} rather than running it again.",
                request.Id,
                request.Action,
                already.Status);

            return new ActionResultDto
            {
                RequestId = already.RequestId,
                Status = already.Status,
                Output = already.Output,
                CollectedData = already.CollectedData,
                CompletedAtUtc = already.CompletedAtUtc,
            };
        }

        // A prior completion write may have failed in this process. Startup
        // recovery, not a subsequent dispatch, must resolve that journal.
        if (_stateStore.Load().InFlightAction is not null)
            throw new InvalidOperationException("An unresolved action journal blocks further execution.");

        // An action that expired while it sat in a queue must not fire late.
        if (request.ExpiresUtc is { } expiry && expiry <= _clock.UtcNow)
        {
            _logger.LogWarning(
                "Action {RequestId} ({Action}) expired at {ExpiresUtc} and will not be run.",
                request.Id,
                request.Action,
                expiry);

            return Remember(request, ActionOutcome.Denied(
                $"This action expired at {expiry:O} and was not run. A cabinet's state moves on, and an " +
                "approval nobody collected in time is no longer an approval for what is there now."));
        }

        // The catalog check comes first. An action with no compiled-in executor
        // is refused before anything else about the request is considered.
        var executor = _registry.Resolve(request.Action);
        if (executor is null)
        {
            _logger.LogWarning(
                "Action {RequestId} named {Action}, which this agent has no executor for. Denied.",
                request.Id,
                request.Action);

            return Remember(request, ActionOutcome.Denied(
                $"This agent has no executor for {request.Action}, so it cannot be performed. " +
                "The agent runs only actions it has compiled-in support for."));
        }

        if (!TryValidateEnvelope(request, out var envelopeFailure))
        {
            _logger.LogWarning(
                "Action {RequestId} ({Action}) failed the agent's own validation: {Reason}",
                request.Id,
                request.Action,
                envelopeFailure);

            return Remember(request, ActionOutcome.Denied(envelopeFailure));
        }

        var timeout = ResolveTimeout(request.Action);

        _logger.LogInformation(
            "Running action {RequestId} ({Action}) requested by {RequestedBy} for {Reason}. Timeout {TimeoutSeconds}s.",
            request.Id,
            request.Action,
            request.RequestedByUserId,
            request.Reason,
            timeout.TotalSeconds);

        // Journalled before it runs, so a machine that never comes back from a
        // reboot still leaves a record that something was in progress.
        _stateStore.Update(current => current with
        {
            InFlightAction = new InFlightAction
            {
                RequestId = request.Id,
                Action = request.Action,
                StartedUtc = _clock.UtcNow,
            },
        });

        var outcome = await RunWithTimeoutAsync(executor, request, timeout, cancellationToken)
            .ConfigureAwait(false);

        // Completion and journal removal are one durable transition. A failed
        // write must leave the in-flight evidence intact.
        return Remember(request, outcome);
    }

    /// <summary>
    /// Builds the result and records that this request has been carried out.
    /// </summary>
    /// <remarks>
    /// Recorded for every terminal outcome, refusals included: a request the
    /// agent refused must be refused the same way the second time, not
    /// reconsidered against a machine whose state has moved on.
    /// </remarks>
    private ActionResultDto Remember(ActionRequestDto request, ActionOutcome outcome)
    {
        ActionResultDto result = Result(request, outcome);

        PersistResult(request.Action, result);
        return result;
    }

    private void PersistResult(ActionName action, ActionResultDto result)
    {
        _stateStore.Update(current =>
        {
            var completed = new List<CompletedAction>(current.CompletedActions.Count + 1)
            {
                new()
                {
                    RequestId = result.RequestId,
                    Action = action,
                    Status = result.Status,
                    CompletedAtUtc = result.CompletedAtUtc,
                    Output = result.Output,
                    CollectedData = result.CollectedData,
                },
            };

            completed.AddRange(current.CompletedActions
                .Where(c => c.RequestId != result.RequestId)
                .Take(RememberedActionCount - 1));

            return current with
            {
                CompletedActions = completed,
                InFlightAction = current.InFlightAction?.RequestId == result.RequestId ? null : current.InFlightAction,
            };
        });
    }

    private async Task<ActionOutcome> RunWithTimeoutAsync(
        IActionExecutor executor,
        ActionRequestDto request,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);

        try
        {
            return await executor.ExecuteAsync(request, timeoutSource.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeoutSource.IsCancellationRequested
                                                 && !cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning(
                "Action {RequestId} ({Action}) exceeded its {TimeoutSeconds}s timeout.",
                request.Id,
                request.Action,
                timeout.TotalSeconds);

            // Reported honestly as a timeout. The action may still be finishing
            // on the machine, which is why this is not reported as a failure.
            return ActionOutcome.TimedOut(
                $"The action did not complete within {timeout.TotalSeconds:F0} seconds. " +
                "It may still be in progress on the cabinet.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning(
                "Action {RequestId} ({Action}) was interrupted by agent shutdown.",
                request.Id,
                request.Action);

            return new ActionOutcome
            {
                Status = ActionStatus.UnknownResult,
                Output = "The agent shut down while this action was running. It was not resumed.",
            };
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Action {RequestId} ({Action}) threw.", request.Id, request.Action);

            return ActionOutcome.Failed($"{e.GetType().Name}: {e.Message}");
        }
    }

    /// <summary>
    /// Checks the parts of a request that are the same for every action.
    /// </summary>
    /// <remarks>
    /// The server has validated all of this already. It is checked again here
    /// because "the server already checked" is an assumption, and this is the
    /// last point at which a bad assumption can still be caught.
    /// </remarks>
    private bool TryValidateEnvelope(ActionRequestDto request, out string failureReason)
    {
        if (request.Id == Guid.Empty)
        {
            failureReason = "The request carries no id, so its result could not be attributed.";
            return false;
        }

        // The zero value is deliberately unused in the contract, so it can only
        // arrive from a default-initialised or absent field.
        if (!Enum.IsDefined(request.Action))
        {
            failureReason = $"'{request.Action}' is not a member of the action catalog.";
            return false;
        }

        var state = _stateStore.Load();

        if (!state.IsApproved)
        {
            failureReason = "This cabinet is not approved, so it performs no actions.";
            return false;
        }

        // An action addressed to a different cabinet is never run, even though
        // it arrived on this one's connection.
        if (request.CabinetId != state.CabinetId)
        {
            failureReason =
                $"The request is addressed to cabinet {request.CabinetId}, which is not this cabinet.";
            return false;
        }

        // Every action is audited against a stated reason and a named requester.
        // A request without them cannot be justified after the fact, which on a
        // DEA-regulated machine is reason enough to refuse it.
        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            failureReason = "The request carries no reason, which every action on a cabinet requires.";
            return false;
        }

        if (request.RequestedByUserId == Guid.Empty)
        {
            failureReason = "The request names no requesting user.";
            return false;
        }

        failureReason = string.Empty;
        return true;
    }

    private TimeSpan ResolveTimeout(ActionName action)
    {
        if (_options.TimeoutSecondsByAction.TryGetValue(action.ToString(), out var configured) && configured > 0)
        {
            return TimeSpan.FromSeconds(configured);
        }

        return TimeSpan.FromSeconds(_options.DefaultTimeoutSeconds);
    }

    private ActionResultDto Result(ActionRequestDto request, ActionOutcome outcome) => new()
    {
        RequestId = request.Id,
        Status = outcome.Status,
        Output = outcome.Output,
        CompletedAtUtc = _clock.UtcNow,
        CollectedData = outcome.CollectedData,
    };
}
