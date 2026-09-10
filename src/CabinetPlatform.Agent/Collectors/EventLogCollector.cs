using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Critical, error and warning records from the Application, System and
/// Security logs over a recent window.
/// </summary>
/// <remarks>
/// The Security log needs elevation to read; the agent runs as LocalSystem,
/// which has it. A cabinet that cannot read Security is still worth reporting
/// on, so a failure on one log is recorded and the other two still collect.
/// </remarks>
public sealed class EventLogCollector : ICollector
{
    private static readonly EventLogName[] Logs =
    {
        EventLogName.Application,
        EventLogName.System,
        EventLogName.Security,
    };

    private readonly IEventLogReader _reader;
    private readonly CollectionOptions _options;
    private readonly ILogger<EventLogCollector> _logger;

    public EventLogCollector(
        IEventLogReader reader,
        IOptions<AgentOptions> options,
        ILogger<EventLogCollector> logger)
    {
        _reader = reader;
        _options = options.Value.Collection;
        _logger = logger;
    }

    public string SectionName => CollectorSections.EventLogs;

    public Task CollectAsync(CheckInDraft draft, CancellationToken cancellationToken)
    {
        var window = TimeSpan.FromHours(_options.EventLogWindowHours);

        // The cap is on the payload as a whole. Dividing it evenly stops a
        // machine with a very noisy Application log from squeezing out the
        // System entries, which are usually the ones that explain a fault.
        var perLogCap = Math.Max(1, _options.EventLogMaxEntries / Logs.Length);

        var entries = new List<EventLogEntry>();
        var failures = new List<string>();

        foreach (var log in Logs)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                entries.AddRange(_reader.Read(log, window, perLogCap, cancellationToken));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                failures.Add($"{log}: {e.GetType().Name}: {e.Message}");
                _logger.LogWarning(e, "The {Log} event log could not be read.", log);
            }
        }

        draft.EventLogs = entries
            .OrderByDescending(entry => entry.TimeCreatedUtc)
            .Take(_options.EventLogMaxEntries)
            .ToArray();

        // Every log failing is a section failure and is surfaced as one. Some
        // logs failing is reported through the successful ones plus this throw
        // only when nothing at all could be read.
        if (failures.Count == Logs.Length)
        {
            throw new InvalidOperationException(
                "No event log could be read. " + string.Join("; ", failures));
        }

        return Task.CompletedTask;
    }
}
