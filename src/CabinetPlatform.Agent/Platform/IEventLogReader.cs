using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Reads Windows event log records. Abstracted so the collector's windowing,
/// capping and level mapping can be tested without an event log.
/// </summary>
public interface IEventLogReader
{
    /// <summary>
    /// Reads up to <paramref name="maximumEntries"/> records from one log,
    /// newest first, restricted to the given levels and time window.
    /// </summary>
    IReadOnlyList<EventLogEntry> Read(
        EventLogName log,
        TimeSpan window,
        int maximumEntries,
        CancellationToken cancellationToken);
}
