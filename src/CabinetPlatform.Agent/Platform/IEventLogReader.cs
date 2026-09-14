using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Reads Windows event log records. Abstracted so the collector's windowing,
/// capping and level mapping can be tested without an event log.
/// </summary>
public interface IEventLogReader
{
    /// <summary>Discovers local event channels without changing their configuration.</summary>
    /// <remarks>Older implementations explicitly report discovery as unavailable.</remarks>
    EventChannelDiscoveryResult DiscoverChannels(CancellationToken cancellationToken)
        => new();

    /// <summary>Detailed view result. Legacy test/platform adapters retain their record-only implementation.</summary>
    EventLogViewResultDto RunViewResult(EventLogViewDefinition definition, CancellationToken cancellationToken)
    {
        var entries = RunView(definition, cancellationToken);
        return new EventLogViewResultDto
        {
            ViewId = definition.ViewId, ViewDisplayName = definition.DisplayName, WindowHours = definition.WindowHours,
            Entries = entries, Truncated = entries.Count >= definition.MaximumEntries
        };
    }

    /// <summary>
    /// Reads up to <paramref name="maximumEntries"/> records from one log,
    /// newest first, restricted to the given levels and time window.
    /// </summary>
    IReadOnlyList<EventLogEntry> Read(
        EventLogName log,
        TimeSpan window,
        int maximumEntries,
        CancellationToken cancellationToken);

    /// <summary>
    /// Runs one server-defined view across the logs it names.
    /// </summary>
    /// <remarks>
    /// The agent composes the XPath itself from the view's fields. It never
    /// receives one, and there is no overload here that takes one.
    /// </remarks>
    /// <param name="definition">The view, as the server expanded it.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    IReadOnlyList<EventLogEntry> RunView(
        EventLogViewDefinition definition, CancellationToken cancellationToken);
}
