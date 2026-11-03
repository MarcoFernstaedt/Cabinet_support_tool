using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Runtime.Versioning;
using System.Xml;
using System.Xml.Linq;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Windows;

/// <summary>
/// eventlog.channels, eventlog.query and eventlog.get. Runs in the broker,
/// because several channels are readable only by administrators. Only names
/// in the compiled-in allowed list reach here (the schema enforces it); the
/// list is checked once more as a second line of defence.
/// </summary>
[SupportedOSPlatform("windows")]
public static class EventLogOperations
{
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(25);
    private const int MaxScanned = 50_000;

    private static void RequireAllowed(string log)
    {
        if (!Catalog.AllowedLogs.Contains(log, StringComparer.Ordinal))
            throw new OperationFailedException("execution_failed", "That event log is not readable by this agent.");
    }

    public static Task<EventlogChannelsOutput> ChannelsAsync(EmptyParams _, CancellationToken token)
    {
        var channels = new List<ChannelInfo>();
        foreach (string log in Catalog.AllowedLogs)
        {
            token.ThrowIfCancellationRequested();
            channels.Add(Channel(log));
        }
        return Task.FromResult(new EventlogChannelsOutput { Channels = channels });
    }

    private static ChannelInfo Channel(string log)
    {
        try
        {
            bool enabled;
            using (var config = new EventLogConfiguration(log)) enabled = config.IsEnabled;
            EventLogInformation info = EventLogSession.GlobalSession.GetLogInformation(log, PathType.LogName);
            return new ChannelInfo
            {
                Log = log, Enabled = enabled, Available = true,
                EntryCount = info.RecordCount is >= 0 ? info.RecordCount : null,
                SizeBytes = info.FileSize is >= 0 ? info.FileSize : null,
                NewestEntryAt = enabled || info.RecordCount > 0 ? Newest(log) : null,
            };
        }
        catch (EventLogNotFoundException)
        {
            return new ChannelInfo { Log = log, Enabled = false, Available = false, EntryCount = null, SizeBytes = null, NewestEntryAt = null };
        }
        catch (Exception e) when (e is EventLogException or UnauthorizedAccessException)
        {
            return new ChannelInfo { Log = log, Enabled = false, Available = true, EntryCount = null, SizeBytes = null, NewestEntryAt = null };
        }
    }

    private static DateTimeOffset? Newest(string log)
    {
        using var reader = new EventLogReader(new EventLogQuery(log, PathType.LogName, "*") { ReverseDirection = true });
        using EventRecord? record = reader.ReadEvent();
        return record?.TimeCreated is { } t ? new DateTimeOffset(t.ToUniversalTime(), TimeSpan.Zero) : null;
    }

    public static Task<EventlogQueryOutput> QueryAsync(EventlogQueryParams p, CancellationToken token)
    {
        RequireAllowed(p.Log);
        int pageSize = p.PageSize ?? 100;
        EventQueryBuilder.Query query = EventQueryBuilder.Build(p);
        var entries = new List<EventSummary>(Math.Min(pageSize, 500));
        var watch = Stopwatch.StartNew();
        bool truncated = false, more = false;
        int scanned = 0;
        try
        {
            using var reader = new EventLogReader(new EventLogQuery(p.Log, PathType.LogName, query.Filter) { ReverseDirection = true });
            while (true)
            {
                token.ThrowIfCancellationRequested();
                if (watch.Elapsed > Budget || ++scanned > MaxScanned) { truncated = true; break; }
                using EventRecord? record = reader.ReadEvent();
                if (record is null) break;
                if (query.SourceInCode is { } source && !string.Equals(record.ProviderName, source, StringComparison.OrdinalIgnoreCase)) continue;
                if (record.RecordId is not { } id || id < 1) continue;
                if (entries.Count == pageSize) { more = true; break; }
                entries.Add(new EventSummary
                {
                    RecordId = id,
                    Time = Utc(record.TimeCreated),
                    Level = EventLevels.FromWindows(record.Level),
                    Source = EventText.ShortText(record.ProviderName),
                    EventId = record.Id is >= 0 and <= 65535 ? record.Id : 0,
                    FirstLine = EventText.FirstLine(Message(record)),
                    Fields = KernelPowerFields.Applies(record.ProviderName, record.Id)
                        ? KernelPowerFields.Pick(EventData(Safe(record.ToXml) ?? "").Select(d => new KeyValuePair<string, string?>(d.Name, d.Value)))
                        : null,
                });
            }
        }
        catch (EventLogNotFoundException)
        {
            throw new OperationFailedException("unavailable", "This event log does not exist on this cabinet.");
        }
        catch (EventLogException)
        {
            throw new OperationFailedException("execution_failed", "Windows could not read this event log.");
        }
        return Task.FromResult(new EventlogQueryOutput
        {
            Log = p.Log, Entries = entries, Truncated = truncated,
            NextBeforeRecordId = (more || truncated) && entries.Count > 0 ? entries[^1].RecordId : null,
        });
    }

    public static Task<EventlogGetOutput> GetAsync(EventlogGetParams p, CancellationToken token)
    {
        RequireAllowed(p.Log);
        try
        {
            using var reader = new EventLogReader(new EventLogQuery(p.Log, PathType.LogName, EventQueryBuilder.ForRecord(p.RecordId)));
            using EventRecord? record = reader.ReadEvent();
            if (record is null) throw new OperationFailedException("not_found", "No entry with that record ID is in this log; it may have been overwritten.");
            string xml = record.ToXml();
            var data = EventData(xml);
            return Task.FromResult(new EventlogGetOutput
            {
                Log = p.Log, RecordId = p.RecordId, Time = Utc(record.TimeCreated), Level = EventLevels.FromWindows(record.Level),
                Source = EventText.ShortText(record.ProviderName), EventId = record.Id is >= 0 and <= 65535 ? record.Id : 0,
                TaskCategory = Optional(() => record.TaskDisplayName),
                Keywords = Safe(() => record.KeywordsDisplayNames?.Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => EventText.ShortText(k)).Take(32).ToList()) ?? new List<string>(),
                Opcode = Optional(() => record.OpcodeDisplayName),
                ProcessId = record.ProcessId, ThreadId = record.ThreadId,
                Computer = record.MachineName is { } m ? EventText.ShortText(m) : null,
                Message = EventText.LongText(Message(record), 32_768),
                EventData = data,
                DeviceInstanceId = data.Where(d => d.Name.Equals("DeviceInstanceId", StringComparison.OrdinalIgnoreCase) || d.Name.Equals("DeviceInstanceID", StringComparison.OrdinalIgnoreCase))
                    .Select(d => d.Value).FirstOrDefault(v => ContractValues.Is("deviceInstanceId", v)),
                RawXml = EventText.LongText(xml, 65_536),
            });
        }
        catch (EventLogNotFoundException)
        {
            throw new OperationFailedException("unavailable", "This event log does not exist on this cabinet.");
        }
        catch (EventLogException)
        {
            throw new OperationFailedException("execution_failed", "Windows could not read this event log.");
        }
    }

    /// <summary>EventData/Data and UserData fields from the event XML, parsed with DTDs prohibited.</summary>
    internal static List<EventDataField> EventData(string xml)
    {
        var fields = new List<EventDataField>();
        XDocument doc;
        try
        {
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4_000_000 });
            doc = XDocument.Load(reader);
        }
        catch (XmlException)
        {
            return fields;
        }
        XElement? root = doc.Root;
        if (root is null) return fields;
        XElement? eventData = root.Elements().FirstOrDefault(e => e.Name.LocalName == "EventData");
        if (eventData is not null)
        {
            int index = 0;
            foreach (XElement d in eventData.Elements())
            {
                string name = d.Attribute("Name")?.Value is { Length: > 0 } n ? n : $"{d.Name.LocalName}{index}";
                fields.Add(Field(name, d.Value));
                index++;
                if (fields.Count == 128) break;
            }
        }
        XElement? userData = root.Elements().FirstOrDefault(e => e.Name.LocalName == "UserData");
        foreach (XElement d in userData?.Elements().SelectMany(e => e.Elements()) ?? Enumerable.Empty<XElement>())
        {
            if (fields.Count == 128) break;
            fields.Add(Field(d.Name.LocalName, d.Value));
        }
        return fields;
    }

    private static EventDataField Field(string name, string value) =>
        new() { Name = EventText.ShortText(name), Value = EventText.LongText(value, 4096) };

    private static string Message(EventRecord record) => Safe(record.FormatDescription) ?? "";

    private static DateTimeOffset Utc(DateTime? time) =>
        time is { } t ? new DateTimeOffset(t.ToUniversalTime(), TimeSpan.Zero) : DateTimeOffset.UnixEpoch;

    private static string? Optional(Func<string?> read) => Safe(read) is { Length: > 0 } s ? EventText.ShortText(s) : null;

    private static T? Safe<T>(Func<T?> read) where T : class
    {
        try { return read(); }
        catch (Exception e) when (e is EventLogException or InvalidOperationException) { return null; }
    }
}
