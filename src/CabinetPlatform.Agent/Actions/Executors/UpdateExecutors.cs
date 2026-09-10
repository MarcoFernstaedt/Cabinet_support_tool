using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
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
            var pending = _gateway.SearchPendingUpdates(cancellationToken);

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
/// Registers a scheduled update install for a given UTC time.
/// </summary>
/// <remarks>
/// <para>
/// This writes the schedule and returns. It deliberately does not install
/// anything inline: an install that began during an action would take the
/// cabinet down at whatever moment the action happened to run, rather than at
/// the time a person chose.
/// </para>
/// <para>
/// The schedule is written to the Windows Update policy keys the update agent
/// itself reads, so Windows performs the install on its own terms and inside
/// the machine's maintenance window.
/// </para>
/// </remarks>
public sealed class ScheduleUpdatesExecutor : IActionExecutor
{
    private static readonly string[] PermittedParameters = { ActionParameters.ScheduledUtc };

    private readonly IScheduledUpdateWriter _writer;
    private readonly IClock _clock;
    private readonly ActionOptions _options;
    private readonly ILogger<ScheduleUpdatesExecutor> _logger;

    public ScheduleUpdatesExecutor(
        IScheduledUpdateWriter writer,
        IClock clock,
        IOptions<AgentOptions> options,
        ILogger<ScheduleUpdatesExecutor> logger)
    {
        _writer = writer;
        _clock = clock;
        _options = options.Value.Actions;
        _logger = logger;
    }

    public ActionName Action => ActionName.ScheduleUpdates;

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, PermittedParameters, out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!ActionParameters.TryGetUtcTimestamp(
                request,
                ActionParameters.ScheduledUtc,
                out var scheduledUtc,
                out var parseFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(parseFailure));
        }

        var now = _clock.UtcNow;

        // A time in the past would have Windows install at the next opportunity,
        // which is to say immediately: the opposite of scheduling.
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
            _writer.ScheduleInstall(scheduledUtc);

            _logger.LogInformation(
                "Updates are scheduled to install at {ScheduledUtc:O}, requested by {RequestedBy}.",
                scheduledUtc,
                request.RequestedByUserId);

            return Task.FromResult(ActionOutcome.Succeeded(
                $"Updates are scheduled to install at {scheduledUtc:O}. " +
                "Windows performs the install; the agent does not install anything itself."));
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "The update schedule could not be written.");
            return Task.FromResult(ActionOutcome.Failed($"The update schedule could not be written. {e.Message}"));
        }
    }
}
