using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Asks Windows Update what is applicable. Changes nothing.
/// </summary>
public sealed class ScanForUpdatesExecutor : IActionExecutor
{
    private readonly IWindowsUpdateGateway _gateway;
    private readonly ILogger<ScanForUpdatesExecutor> _logger;

    public ScanForUpdatesExecutor(IWindowsUpdateGateway gateway, ILogger<ScanForUpdatesExecutor> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    public ActionName Action => ActionName.ScanForUpdates;

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, Array.Empty<string>(), out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        try
        {
            // Online: this action exists because somebody asked the cabinet to
            // go and check, not to re-read what it already knew.
            var pending = _gateway.SearchPendingUpdates(online: true, cancellationToken);

            var security = pending.Count(update =>
                update.IsSecurity == true || update.Classification == UpdateClassification.SecurityUpdate);

            _logger.LogInformation(
                "The update scan found {PendingCount} applicable update(s), {SecurityCount} of them security updates.",
                pending.Count,
                security);

            var titles = pending
                .Select(update => update.Title)
                .Where(title => !string.IsNullOrWhiteSpace(title))
                .Take(20)
                .ToArray();

            var summary = $"{pending.Count} update(s) are applicable and not installed, " +
                          $"{security} of them security updates.";

            if (titles.Length > 0)
            {
                summary += Environment.NewLine + string.Join(Environment.NewLine, titles);

                if (pending.Count > titles.Length)
                {
                    summary += $"{Environment.NewLine}...and {pending.Count - titles.Length} more.";
                }
            }

            return Task.FromResult(ActionOutcome.Succeeded(summary));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "The update scan failed.");
            return Task.FromResult(ActionOutcome.Failed($"The update scan failed. {e.Message}"));
        }
    }
}

/// <summary>
/// Records which updates this cabinet is due to install, and when.
/// </summary>
/// <remarks>
/// <para>
/// It writes the schedule and returns. It deliberately does not install
/// anything: an install that began during an action would take the cabinet
/// down at whatever moment the action happened to run, rather than at the time
/// a person chose with a clinic.
/// </para>
/// <para>
/// The schedule is held as a UTC instant in the agent's own state file. That is
/// what makes it survive a reboot, and what makes it correct across a
/// daylight-saving transition between scheduling and execution: a wall-clock
/// time written down in March means a different instant in April, and the
/// instant is what was agreed. The agent's loop performs the install when the
/// instant arrives.
/// </para>
/// </remarks>
public sealed class ScheduleUpdatesExecutor : IActionExecutor
{
    /// <remarks>
    /// The local time travels alongside the UTC instant the server derived from
    /// it. The agent acts on the UTC one and never re-derives it: one
    /// conversion, done by the component that knows the cabinet's zone.
    /// </remarks>
    private static readonly string[] PermittedParameters =
    {
        ActionParameterKeys.ScheduledForUtc,
        ActionParameterKeys.ScheduledForLocal,
        ActionParameterKeys.UpdateIds,
        ActionParameterKeys.RebootIfRequired,
    };

    private readonly IScheduledUpdateWriter _schedule;
    private readonly IClock _clock;
    private readonly ActionOptions _options;
    private readonly ILogger<ScheduleUpdatesExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="schedule">Holds what the cabinet is due to install.</param>
    /// <param name="clock">The current instant.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public ScheduleUpdatesExecutor(
        IScheduledUpdateWriter schedule,
        IClock clock,
        IOptions<AgentOptions> options,
        ILogger<ScheduleUpdatesExecutor> logger)
    {
        _schedule = schedule;
        _clock = clock;
        _options = options.Value.Actions;
        _logger = logger;
    }

    /// <inheritdoc />
    public ActionName Action => ActionName.ScheduleUpdates;

    /// <inheritdoc />
    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, PermittedParameters, out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!ActionParameters.TryGetUtcTimestamp(
                request,
                ActionParameterKeys.ScheduledForUtc,
                out var scheduledUtc,
                out var parseFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(parseFailure));
        }

        if (!UpdateIdParameter.TryRead(request, out IReadOnlyList<string> updateIds, out string idFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(idFailure));
        }

        var now = _clock.UtcNow;

        // A time in the past would install at the next opportunity, which is to
        // say immediately: the opposite of scheduling.
        if (scheduledUtc <= now)
        {
            return Task.FromResult(ActionOutcome.Denied(
                $"The requested install time {scheduledUtc:O} is not in the future (now {now:O})."));
        }

        var latest = now.AddDays(_options.MaxUpdateScheduleDays);

        if (scheduledUtc > latest)
        {
            // A schedule far enough out is indistinguishable from never
            // patching, and on these machines that is a compliance problem.
            return Task.FromResult(ActionOutcome.Denied(
                $"The requested install time {scheduledUtc:O} is more than " +
                $"{_options.MaxUpdateScheduleDays} days away, which this agent will not schedule."));
        }

        try
        {
            _schedule.Schedule(new ScheduledUpdateInstall
            {
                ActionRequestId = request.Id,
                RequestedByUserId = request.RequestedByUserId,
                ScheduledForUtc = scheduledUtc,
                UpdateIds = updateIds,
                RebootIfRequired =
                    ActionParameters.GetBooleanFlag(request, ActionParameterKeys.RebootIfRequired),
            });

            return Task.FromResult(ActionOutcome.Succeeded(
                $"{updateIds.Count} update(s) are scheduled to install at {scheduledUtc:O}. " +
                "The outcome will be reported on the check-in after the install runs, not now."));
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "The update schedule could not be written.");
            return Task.FromResult(ActionOutcome.Failed($"The update schedule could not be written. {e.Message}"));
        }
    }
}

/// <summary>
/// Installs specific updates immediately.
/// </summary>
/// <remarks>
/// Disruptive and approved by a second person, because it takes the cabinet out
/// of service for as long as the install runs and may leave it needing a
/// restart. The outcome reported here is what the machine actually did, not
/// what was asked for.
/// </remarks>
public sealed class InstallUpdatesNowExecutor : IActionExecutor
{
    private static readonly string[] PermittedParameters =
    {
        ActionParameterKeys.UpdateIds,
        ActionParameterKeys.RebootIfRequired,
    };

    private readonly IWindowsUpdateGateway _gateway;
    private readonly IAgentStateStore _stateStore;
    private readonly IClock _clock;
    private readonly ILogger<InstallUpdatesNowExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="gateway">The Windows Update Agent.</param>
    /// <param name="stateStore">Holds outcomes until a check-in carries them.</param>
    /// <param name="clock">The current instant.</param>
    /// <param name="logger">Diagnostic log.</param>
    public InstallUpdatesNowExecutor(
        IWindowsUpdateGateway gateway,
        IAgentStateStore stateStore,
        IClock clock,
        ILogger<InstallUpdatesNowExecutor> logger)
    {
        _gateway = gateway;
        _stateStore = stateStore;
        _clock = clock;
        _logger = logger;
    }

    /// <inheritdoc />
    public ActionName Action => ActionName.InstallUpdatesNow;

    /// <inheritdoc />
    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, PermittedParameters, out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!UpdateIdParameter.TryRead(request, out IReadOnlyList<string> updateIds, out string idFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(idFailure));
        }

        try
        {
            UpdateInstallOutcome outcome = _gateway.InstallUpdates(updateIds, cancellationToken);

            outcome = outcome with
            {
                ActionRequestId = request.Id,
                CompletedUtc = _clock.UtcNow,
            };

            // Queued for the next check-in as well as returned here. The result
            // of an action can be lost if the machine restarts before it is
            // reported; the install itself cannot be undone, and a fleet that
            // loses the record believes it is patched when it is not.
            UpdateOutcomeQueue.Enqueue(_stateStore, outcome);

            var failed = outcome.Results
                .Where(r => r.ResultCode is not (UpdateResultCode.Succeeded
                    or UpdateResultCode.SucceededWithErrors))
                .ToList();

            string reboot = outcome.RebootRequired == true
                ? " The cabinet needs a restart to finish; that is a separate action."
                : string.Empty;

            string summary = failed.Count == 0
                ? $"{outcome.Results.Count} update(s) installed.{reboot}"
                : $"{outcome.Results.Count - failed.Count} of {outcome.Results.Count} update(s) " +
                  $"installed; {failed.Count} did not.{reboot}";

            return Task.FromResult(ActionOutcome.Collected(
                summary, JsonSerializer.Serialize(outcome, AgentJson.SerializerOptions)));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Deliberately not swallowed. An install that was cut off partway
            // has left the machine in a state nobody can describe, and the
            // dispatcher reporting a timeout is the honest outcome.
            throw;
        }
        catch (Exception e)
        {
            _logger.LogError(e, "The update install failed.");
            return Task.FromResult(ActionOutcome.Failed($"The update install failed. {e.Message}"));
        }
    }
}

/// <summary>Withdraws a pending scheduled install.</summary>
public sealed class CancelScheduledUpdatesExecutor : IActionExecutor
{
    private readonly IScheduledUpdateWriter _schedule;
    private readonly ILogger<CancelScheduledUpdatesExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="schedule">Holds what the cabinet is due to install.</param>
    /// <param name="logger">Diagnostic log.</param>
    public CancelScheduledUpdatesExecutor(
        IScheduledUpdateWriter schedule, ILogger<CancelScheduledUpdatesExecutor> logger)
    {
        _schedule = schedule;
        _logger = logger;
    }

    /// <inheritdoc />
    public ActionName Action => ActionName.CancelScheduledUpdates;

    /// <inheritdoc />
    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, Array.Empty<string>(), out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        ScheduledUpdateInstall? existing = _schedule.Read();

        if (!_schedule.Cancel())
        {
            // Not a failure. The requested end state is the actual state.
            return Task.FromResult(ActionOutcome.Succeeded(
                "This cabinet had no scheduled update install, so nothing was cancelled."));
        }

        _logger.LogInformation(
            "The scheduled install of {UpdateCount} update(s) due at {ScheduledUtc:O} was cancelled.",
            existing?.UpdateIds.Count ?? 0,
            existing?.ScheduledForUtc);

        return Task.FromResult(ActionOutcome.Succeeded(
            existing is null
                ? "The scheduled update install was cancelled."
                : $"The scheduled install of {existing.UpdateIds.Count} update(s), due at " +
                  $"{existing.ScheduledForUtc:O}, was cancelled."));
    }
}

/// <summary>Reads what this cabinet is due to install, and when in its own time.</summary>
public sealed class GetScheduledUpdatesExecutor : IActionExecutor
{
    private readonly IScheduledUpdateWriter _schedule;

    /// <summary>Creates the executor.</summary>
    /// <param name="schedule">Holds what the cabinet is due to install.</param>
    public GetScheduledUpdatesExecutor(IScheduledUpdateWriter schedule) => _schedule = schedule;

    /// <inheritdoc />
    public ActionName Action => ActionName.GetScheduledUpdates;

    /// <inheritdoc />
    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, Array.Empty<string>(), out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        ScheduledUpdateInstall? existing = _schedule.Read();

        // The cabinet's own zone, read here rather than carried forward from
        // when the schedule was written. Across a daylight-saving transition
        // the wall-clock time the machine will actually install at differs from
        // the one written down by an hour, and this is the honest answer.
        ScheduledUpdateInstallDto dto =
            ScheduledUpdateWriter.Describe(existing, TimeZoneInfo.Local);

        string summary = existing is null
            ? "This cabinet has no scheduled update install."
            : $"{existing.UpdateIds.Count} update(s) are due at " +
              $"{dto.ScheduledForCabinetLocal:yyyy-MM-dd HH:mm} cabinet time " +
              $"({existing.ScheduledForUtc:O}).";

        return Task.FromResult(ActionOutcome.Collected(
            summary, JsonSerializer.Serialize(dto, AgentJson.SerializerOptions)));
    }
}

/// <summary>
/// Reads and validates the comma-separated list of update identifiers.
/// </summary>
/// <remarks>
/// Parsed as GUIDs rather than accepted as text. A Windows Update identifier is
/// a GUID, and requiring one is what keeps this parameter a name rather than a
/// string the agent might do something else with.
/// </remarks>
internal static class UpdateIdParameter
{
    public static bool TryRead(
        ActionRequestDto request, out IReadOnlyList<string> updateIds, out string failureReason)
    {
        updateIds = Array.Empty<string>();

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.UpdateIds, out string raw, out failureReason))
        {
            return false;
        }

        string[] parts = raw.Split(
            ',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var parsed = new List<string>(parts.Length);

        foreach (string part in parts)
        {
            if (!Guid.TryParse(part, out Guid id))
            {
                failureReason = $"'{part}' is not a Windows Update identifier.";
                return false;
            }

            parsed.Add(id.ToString());
        }

        if (parsed.Count == 0)
        {
            failureReason = "No updates were named. An install names the updates a person chose.";
            return false;
        }

        updateIds = parsed;
        failureReason = string.Empty;
        return true;
    }
}

/// <summary>
/// Holds install outcomes until a check-in has carried them to the server.
/// </summary>
/// <remarks>
/// On disk, and bounded. An install cannot be undone, so the record of what it
/// did is the only thing that can be lost — and losing it leaves a fleet
/// believing it is patched when it is not.
/// </remarks>
internal static class UpdateOutcomeQueue
{
    /// <summary>How many unreported outcomes the agent keeps.</summary>
    /// <remarks>
    /// Small: outcomes are reported on the next check-in, so a backlog means an
    /// outage, and twenty covers a long one. Unbounded growth here would turn
    /// the state file into a patch history.
    /// </remarks>
    public const int MaximumQueued = 20;

    public static void Enqueue(IAgentStateStore stateStore, UpdateInstallOutcome outcome) =>
        stateStore.Update(current =>
        {
            var queued = new List<UpdateInstallOutcome>(current.PendingUpdateOutcomes.Count + 1)
            {
                outcome,
            };

            queued.AddRange(current.PendingUpdateOutcomes
                .Where(o => o.ActionRequestId != outcome.ActionRequestId)
                .Take(MaximumQueued - 1));

            return current with { PendingUpdateOutcomes = queued };
        });

    /// <summary>Clears the outcomes a check-in has just carried.</summary>
    /// <param name="stateStore">The agent's durable state.</param>
    /// <param name="reported">The outcomes the server accepted.</param>
    public static void Clear(IAgentStateStore stateStore, IReadOnlyList<UpdateInstallOutcome> reported)
    {
        if (reported.Count == 0)
        {
            return;
        }

        var carried = reported.Select(o => o.ActionRequestId).ToHashSet();

        stateStore.Update(current => current with
        {
            PendingUpdateOutcomes = current.PendingUpdateOutcomes
                .Where(o => !carried.Contains(o.ActionRequestId))
                .ToList(),
        });
    }
}
