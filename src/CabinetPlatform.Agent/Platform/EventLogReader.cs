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
    private readonly IEventChannelGateway _channels;
    private readonly TimeProvider _clock;
    private readonly IEventRecordGateway _records;

    public EventLogReader(ILogger<EventLogReader> logger) : this(logger, new WindowsEventChannelGateway()) { }

    public EventLogReader(ILogger<EventLogReader> logger, IEventChannelGateway channels, TimeProvider? clock = null, IEventRecordGateway? records = null)
    {
        _logger = logger;
        _channels = channels;
        _clock = clock ?? TimeProvider.System;
        _records = records ?? new WindowsEventRecordGateway();
    }

    /// <inheritdoc />
    public EventChannelDiscoveryResult DiscoverChannels(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        const int maximumNamesExamined = 1024;
        int examined = 0;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var channels = new List<EventChannelInfo>();
        bool truncated = false;
        long started = _clock.GetTimestamp();
        var status = EventChannelDiscoveryStatus.Available;
        try
        {
            using var names = _channels.GetChannelNames(cancellationToken).GetEnumerator();
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                // Cooperative budget: synchronous Windows calls cannot be forcibly interrupted.
                if (_clock.GetElapsedTime(started) >= TimeSpan.FromSeconds(2))
                {
                    truncated = true;
                    break;
                }
                if (!names.MoveNext()) break;
                cancellationToken.ThrowIfCancellationRequested();
                if (examined++ == maximumNamesExamined || _clock.GetElapsedTime(started) >= TimeSpan.FromSeconds(2))
                {
                    truncated = true;
                    break;
                }
                string name = names.Current;
                if (string.IsNullOrWhiteSpace(name) || name.Length > 512 || name.Any(char.IsControl))
                {
                    status = EventChannelDiscoveryStatus.Unavailable;
                    continue;
                }
                if (!seen.Add(name)) continue;
                EventChannelAccess access;
                try
                {
                    access = _channels.Probe(name, cancellationToken);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    access = IsAccessDenied(e) ? EventChannelAccess.AccessDenied : EventChannelAccess.Unavailable;
                }
                cancellationToken.ThrowIfCancellationRequested();
                channels.Add(new EventChannelInfo { Name = name, Access = access });
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            status = IsAccessDenied(e) ? EventChannelDiscoveryStatus.AccessDenied : EventChannelDiscoveryStatus.Unavailable;
        }
        return new EventChannelDiscoveryResult
        {
            Status = status,
            Channels = channels,
            Truncated = truncated,
        };
    }

    private static bool IsAccessDenied(Exception exception)
        => exception is UnauthorizedAccessException or System.Security.SecurityException;

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

    /// <summary>Reads every selected channel with bounded newest-first merging and explicit failures.</summary>
    public EventLogViewResultDto RunViewResult(EventLogViewDefinition definition, CancellationToken token)
    {
        ValidateDefinition(definition);
        var entries = new List<EventLogEntry>();
        var outcomes = new List<EventChannelReadResult>();
        bool truncated = false;
        long started = _clock.GetTimestamp();
        var channels = definition.ChannelNames.Concat(definition.LogNames.Select(ToChannelName))
            .Distinct(StringComparer.OrdinalIgnoreCase);
        foreach (string channel in channels)
        {
            token.ThrowIfCancellationRequested();
            int count = 0;
            bool capped = false;
            EventChannelAccess access = EventChannelAccess.Readable;
            try
            {
                if (_clock.GetElapsedTime(started) >= TimeSpan.FromSeconds(10))
                    throw new TimeoutException();
                using var records = _records.Read(channel, definition, token).GetEnumerator();
                while (true)
                {
                    token.ThrowIfCancellationRequested();
                    if (_clock.GetElapsedTime(started) >= TimeSpan.FromSeconds(10))
                        throw new TimeoutException();
                    if (!records.MoveNext()) break;
                    if (count == definition.MaximumEntries) { capped = true; break; }
                    entries.Add(records.Current);
                    count++;
                }
            }
            catch (EventChannelDisabledException) { access = EventChannelAccess.Disabled; }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                access = IsAccessDenied(e) ? EventChannelAccess.AccessDenied : EventChannelAccess.Unavailable;
                _logger.LogWarning("Record read for {Channel} ended with {Access}.", channel, access);
            }
            token.ThrowIfCancellationRequested();
            outcomes.Add(new EventChannelReadResult { Name = channel, Access = access, RecordsRead = count, Truncated = capped });
            truncated |= capped || entries.Count > definition.MaximumEntries;
            // Keep at most two channels' worth resident, then merge to the global ceiling.
            entries = entries.OrderByDescending(e => e.TimeCreatedUtc).Take(definition.MaximumEntries).ToList();
        }
        return new EventLogViewResultDto
        {
            ViewId = definition.ViewId, ViewDisplayName = definition.DisplayName,
            WindowHours = definition.WindowHours, Entries = entries, ChannelReads = outcomes, Truncated = truncated
        };
    }

    internal static void ValidateDefinition(EventLogViewDefinition definition)
    {
        if (definition.LogNames is null || definition.ChannelNames is null || definition.Sources is null || definition.EventIds is null ||
            definition.LogNames.Count + definition.ChannelNames.Count is < 1 or > 16 ||
            definition.LogNames.Any(n => !Enum.IsDefined(n)) || definition.ChannelNames.Any(n => !EventChannelName.IsValid(n)) ||
            definition.WindowHours is < 1 or > 168 || definition.MaximumEntries is < 1 or > 5000 ||
            definition.Sources.Count > 50 || definition.Sources.Any(s => !EventLogViewQueryBuilder.IsSafeProviderName(s)) ||
            definition.EventIds.Count > 200 || definition.EventIds.Any(i => i is < 0 or > 65535) ||
            !Enum.IsDefined(definition.MinimumLevel) || definition.MinimumLevel == EventLogLevel.Unknown)
            throw new ArgumentException("The saved view contains invalid or unbounded fields.");
    }

    /// <inheritdoc />
    public IReadOnlyList<EventLogEntry> RunView(EventLogViewDefinition definition, CancellationToken cancellationToken)
        => RunViewResult(definition, cancellationToken).Entries;

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
