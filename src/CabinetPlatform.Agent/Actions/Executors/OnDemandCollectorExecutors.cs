using System.Globalization;
using System.Text.Json;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Fetches a window of Windows event log records, on request.
/// </summary>
/// <remarks>
/// <para>
/// Event logs are deliberately not part of any routine check-in. Seven thousand
/// cabinets sending a day of records every few minutes would dominate storage
/// while being read for a handful of them, and the handful is always
/// identifiable in advance: a rep is looking at one cabinet because something
/// is wrong with it.
/// </para>
/// <para>
/// The records come back on the action's result and are stored against it, not
/// folded into the telemetry tables.
/// </para>
/// </remarks>
public sealed class CollectEventLogsExecutor : IActionExecutor
{
    private readonly EventLogCollector _collector;
    private readonly ILogger<CollectEventLogsExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="collector">Reads the Windows logs.</param>
    /// <param name="logger">Diagnostic log.</param>
    public CollectEventLogsExecutor(EventLogCollector collector, ILogger<CollectEventLogsExecutor> logger)
    {
        _collector = collector;
        _logger = logger;
    }

    /// <inheritdoc />
    public ActionName Action => ActionName.CollectEventLogs;

    /// <inheritdoc />
    public async Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request,
                new[]
                {
                    ActionParameterKeys.LogName,
                    ActionParameterKeys.HoursOfHistory,
                    ActionParameterKeys.MaxEntries,
                    ActionParameterKeys.MinimumLevel,
                },
                out string unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        var draft = new CheckInDraft();

        try
        {
            await _collector.CollectAsync(draft, CheckInTier.Full, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _logger.LogWarning(e, "The event log could not be read.");
            return ActionOutcome.Failed($"The event log could not be read. {e.Message}");
        }

        IReadOnlyList<EventLogEntry> entries = Filter(draft.EventLogs ?? Array.Empty<EventLogEntry>(), request);

        return ActionOutcome.Collected(
            $"Collected {entries.Count} event log record(s).",
            JsonSerializer.Serialize(entries, AgentJson.SerializerOptions));
    }

    /// <summary>
    /// Narrows the collected window to what was asked for.
    /// </summary>
    /// <remarks>
    /// Applied here rather than pushed into the collector so that the routine
    /// collector keeps one behaviour. An unparseable bound is ignored rather
    /// than treated as zero, which would return nothing and look like a machine
    /// with a clean log.
    /// </remarks>
    private static IReadOnlyList<EventLogEntry> Filter(
        IReadOnlyList<EventLogEntry> entries, ActionRequestDto request)
    {
        IEnumerable<EventLogEntry> filtered = entries;

        if (request.Parameters.TryGetValue(ActionParameterKeys.LogName, out string? rawLog) &&
            Enum.TryParse(rawLog, ignoreCase: true, out EventLogName logName))
        {
            filtered = filtered.Where(e => e.LogName == logName);
        }

        if (request.Parameters.TryGetValue(ActionParameterKeys.MinimumLevel, out string? rawLevel) &&
            Enum.TryParse(rawLevel, ignoreCase: true, out EventLogLevel minimum))
        {
            filtered = filtered.Where(e => e.Level >= minimum);
        }

        if (request.Parameters.TryGetValue(ActionParameterKeys.MaxEntries, out string? rawMax) &&
            int.TryParse(rawMax, NumberStyles.None, CultureInfo.InvariantCulture, out int max) &&
            max > 0)
        {
            filtered = filtered.Take(max);
        }

        return filtered.ToArray();
    }
}

/// <summary>
/// Fetches the current process list, on request.
/// </summary>
/// <remarks>
/// On demand for the same reason as the event log: a process list is large,
/// changes constantly, and is read for one cabinet at a time when somebody is
/// already looking at it.
/// </remarks>
public sealed class CollectProcessListExecutor : IActionExecutor
{
    private readonly PerformanceCollector _collector;
    private readonly ILogger<CollectProcessListExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="collector">Samples the performance counters and processes.</param>
    /// <param name="logger">Diagnostic log.</param>
    public CollectProcessListExecutor(
        PerformanceCollector collector, ILogger<CollectProcessListExecutor> logger)
    {
        _collector = collector;
        _logger = logger;
    }

    /// <inheritdoc />
    public ActionName Action => ActionName.CollectProcessList;

    /// <inheritdoc />
    public async Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, new[] { ActionParameterKeys.MaxEntries }, out string unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        var draft = new CheckInDraft();

        try
        {
            await _collector
                .CollectAsync(
                    draft,
                    includeProcesses: true,

                    // Not the startup programs. They ride the inventory tier,
                    // and fetching them here would put a second copy in the
                    // action's collected data for nobody to read.
                    includeStartupPrograms: false,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _logger.LogWarning(e, "The process list could not be read.");
            return ActionOutcome.Failed($"The process list could not be read. {e.Message}");
        }

        IReadOnlyList<ProcessInfo> processes = draft.Performance?.Processes ?? Array.Empty<ProcessInfo>();

        if (request.Parameters.TryGetValue(ActionParameterKeys.MaxEntries, out string? rawMax) &&
            int.TryParse(rawMax, NumberStyles.None, CultureInfo.InvariantCulture, out int max) &&
            max > 0)
        {
            processes = processes.Take(max).ToArray();
        }

        return ActionOutcome.Collected(
            $"Collected {processes.Count} process(es).",
            JsonSerializer.Serialize(processes, AgentJson.SerializerOptions));
    }
}
