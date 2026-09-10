using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Runtime.Versioning;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Reads the Windows event logs through <see cref="EventLogQuery"/>.
/// </summary>
/// <remarks>
/// The filtering is done in the XPath query, not in the agent. Enumerating a
/// Security log with millions of records and discarding most of them in managed
/// code would take minutes and a great deal of memory on a machine that is
/// meant to be dispensing medication.
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class EventLogReader : IEventLogReader
{
    private readonly ILogger<EventLogReader> _logger;

    public EventLogReader(ILogger<EventLogReader> logger) => _logger = logger;

    public IReadOnlyList<EventLogEntry> Read(
        EventLogName log,
        TimeSpan window,
        int maximumEntries,
        CancellationToken cancellationToken)
    {
        if (maximumEntries <= 0)
        {
            return Array.Empty<EventLogEntry>();
        }

        var query = new EventLogQuery(ToChannelName(log), PathType.LogName, BuildXPathFilter(window))
        {
            // Newest first, so that a capped read keeps the most recent
            // problems rather than the oldest ones still in the window.
            ReverseDirection = true,
        };

        var entries = new List<EventLogEntry>(Math.Min(maximumEntries, 256));

        using var reader = new System.Diagnostics.Eventing.Reader.EventLogReader(query);

        while (entries.Count < maximumEntries)
        {
            cancellationToken.ThrowIfCancellationRequested();

            EventRecord? record;
            try
            {
                record = reader.ReadEvent();
            }
            catch (EventLogException e)
            {
                _logger.LogWarning(e, "Reading the {Log} log stopped early.", log);
                break;
            }

            if (record is null)
            {
                break;
            }

            using (record)
            {
                var entry = ToEntry(log, record);
                if (entry is not null)
                {
                    entries.Add(entry);
                }
            }
        }

        return entries;
    }

    /// <summary>
    /// Builds the XPath filter for critical, error and warning records inside
    /// the window.
    /// </summary>
    /// <remarks>
    /// <c>timediff</c> takes milliseconds and is evaluated by the event log
    /// service against its own clock, which is what makes the window correct on
    /// a machine whose time zone differs from the server's.
    /// </remarks>
    internal static string BuildXPathFilter(TimeSpan window)
    {
        var milliseconds = (long)Math.Max(window.TotalMilliseconds, 1);

        return "*[System[(Level=1 or Level=2 or Level=3) and " +
               $"TimeCreated[timediff(@SystemTime) <= {milliseconds.ToString(CultureInfo.InvariantCulture)}]]]";
    }

    internal static string ToChannelName(EventLogName log) => log switch
    {
        EventLogName.Application => "Application",
        EventLogName.System => "System",
        EventLogName.Security => "Security",
        _ => throw new ArgumentOutOfRangeException(nameof(log), log, "Unknown event log."),
    };

    private EventLogEntry? ToEntry(EventLogName log, EventRecord record)
    {
        try
        {
            var timeCreated = record.TimeCreated;
            if (timeCreated is null)
            {
                return null;
            }

            return new EventLogEntry
            {
                LogName = log,
                Source = record.ProviderName,
                EventId = record.Id,
                Level = MapLevel(record.Level),
                TimeCreatedUtc = new DateTimeOffset(timeCreated.Value.ToUniversalTime(), TimeSpan.Zero),
                Message = ReadMessage(record),
            };
        }
        catch (EventLogException e)
        {
            _logger.LogDebug(e, "An event record in the {Log} log could not be read.", log);
            return null;
        }
    }

    private static string? ReadMessage(EventRecord record)
    {
        string? message;
        try
        {
            // A provider whose message DLL is missing throws here. The record's
            // id and source are still useful, so the message is simply omitted.
            message = record.FormatDescription();
        }
        catch (EventLogException)
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(message))
        {
            return null;
        }

        message = message.Trim();

        // Some providers write kilobytes of XML into a single record. Truncating
        // keeps one noisy provider from crowding out every other log entry.
        const int MaximumMessageLength = 1000;
        return message.Length <= MaximumMessageLength
            ? message
            : message[..MaximumMessageLength] + "...";
    }

    /// <summary>
    /// Maps the Windows numeric level onto the contract's level.
    /// </summary>
    internal static EventLogLevel MapLevel(byte? level) => level switch
    {
        1 => EventLogLevel.Critical,
        2 => EventLogLevel.Error,
        3 => EventLogLevel.Warning,
        4 => EventLogLevel.Information,
        5 => EventLogLevel.Verbose,

        // Level 0 means the provider did not classify the record. The Security
        // log uses it for every audit entry, so it is reported as unknown
        // rather than silently promoted to an error.
        _ => EventLogLevel.Unknown,
    };
}
