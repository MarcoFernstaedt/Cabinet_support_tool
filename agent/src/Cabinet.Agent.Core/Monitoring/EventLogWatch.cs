using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// The event log watcher: Error and Critical entries from the allowed logs become
/// events, and so do Warnings from the logs where a failing drive, controller or other
/// hardware first shows (a retried read, a paging error, a corrected machine check);
/// the server alerts only on the warnings its rules recognize. Each log has a bookmark (the newest record already reported), so an entry
/// is reported once, and its event ID is derived from the log and record, so even a
/// lost bookmark cannot make the server count it twice.
/// </summary>
public sealed class EventLogWatch(StateFile<EventLogWatch.State> store, Func<EventlogQueryParams, CancellationToken, Task<EventlogQueryOutput>> query)
{
    public const int PageSize = 100;

    /// <summary>Logs whose Warnings are collected too: the early signs of hardware trouble are logged there as warnings.</summary>
    public static readonly IReadOnlySet<string> WarningLogs = new HashSet<string>(StringComparer.Ordinal)
    {
        "System", "HardwareEvents", "Microsoft-Windows-Kernel-WHEA/Errors", "Microsoft-Windows-Kernel-WHEA/Operational",
        "Microsoft-Windows-Storage-Storport/Operational", "Microsoft-Windows-Storage-Storport/Health", "Microsoft-Windows-Storage-ClassPnP/Operational",
        "Microsoft-Windows-StorageSpaces-Driver/Operational", "Microsoft-Windows-Ntfs/Operational", "Microsoft-Windows-Kernel-Power/Thermal-Operational",
    };

    public static EventLevel[] LevelsFor(string log) =>
        WarningLogs.Contains(log) ? [EventLevel.Critical, EventLevel.Error, EventLevel.Warning] : [EventLevel.Critical, EventLevel.Error];
    public const int MaxPagesPerLook = 5;
    /// <summary>How far back the first look at a log goes, so problems from just before the install are seen.</summary>
    public static readonly TimeSpan FirstLookBack = TimeSpan.FromHours(24);

    /// <summary>
    /// Crash, storage and hardware evidence goes back further on the first look: 30 days. A cabinet installed after a run of
    /// blue screens or disk errors then still shows what happened before (docs/spec/13-roadmap.md module 4). Only these
    /// fixed (source, event ID) pairs, all in the System log, are read that far back.
    /// </summary>
    public static readonly TimeSpan EvidenceLookBack = TimeSpan.FromDays(30);

    public static readonly IReadOnlyList<(string Source, int[] EventIds)> EvidenceIds =
    [
        ("BugCheck", [1001]), ("Microsoft-Windows-WER-SystemErrorReporting", [1001]), ("Microsoft-Windows-Kernel-Power", [41]), ("EventLog", [6008]),
        ("disk", [7, 11, 15, 51, 52, 153, 154]), ("Ntfs", [55]), ("Microsoft-Windows-Ntfs", [55, 98, 140]),
        ("storahci", [129]), ("stornvme", [129]), ("iaStorA", [129]), ("iaStorAVC", [129]), ("iaStorAC", [129]),
        ("Microsoft-Windows-WHEA-Logger", [17, 18, 19, 47]),
    ];

    public sealed class State
    {
        public Dictionary<string, Bookmark> Logs { get; set; } = new();
    }

    public sealed class Bookmark
    {
        public long RecordId { get; set; }
        public DateTimeOffset Time { get; set; }
    }

    public async Task<IReadOnlyList<AgentEvent>> CheckAsync(string log, DateTimeOffset now, CancellationToken token)
    {
        State state = store.Load();
        state.Logs.TryGetValue(log, out Bookmark? mark);
        // A small overlap guards against clock steps; the record bookmark removes the repeats.
        DateTimeOffset from = mark is null ? now - FirstLookBack : mark.Time - TimeSpan.FromMinutes(5);
        var fresh = new List<EventSummary>();
        long? before = null;
        for (int page = 0; page < MaxPagesPerLook; page++)
        {
            var output = await query(new EventlogQueryParams
            {
                Log = log, Levels = LevelsFor(log), From = from, BeforeRecordId = before, PageSize = PageSize,
            }, token).ConfigureAwait(false);
            var newer = output.Entries.Where(e => mark is null || e.RecordId > mark.RecordId).ToList();
            fresh.AddRange(newer);
            if (newer.Count < output.Entries.Count || output.NextBeforeRecordId is null) break;
            before = output.NextBeforeRecordId;
        }
        // The first look at the System log also reads the crash, storage and hardware evidence from 30 days back to the
        // start of the normal first look; one page per source, so a flood cannot hold the watcher up.
        if (mark is null && log == "System")
            foreach (var (source, ids) in EvidenceIds)
            {
                var older = await query(new EventlogQueryParams
                {
                    Log = log, Levels = LevelsFor(log), From = now - EvidenceLookBack, To = from, Source = source, EventIds = ids, PageSize = PageSize,
                }, token).ConfigureAwait(false);
                fresh.AddRange(older.Entries);
            }
        var ordered = fresh.GroupBy(e => e.RecordId).Select(g => g.First()).OrderBy(e => e.RecordId).ToList();
        if (ordered.Count > 0)
        {
            // After a first look everything since its start has been read, so the next look starts from now, not from the oldest evidence.
            state.Logs[log] = new Bookmark { RecordId = ordered[^1].RecordId, Time = mark is null ? Max(now, ordered.Max(e => e.Time)) : ordered.Max(e => e.Time) };
            store.Save(state);
        }
        else if (mark is null)
        {
            state.Logs[log] = new Bookmark { RecordId = 0, Time = now };
            store.Save(state);
        }
        return Limit(log, ordered, pagesExhausted: fresh.Count >= PageSize * MaxPagesPerLook, now);
    }

    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;

    /// <summary>At most this many entries with the same source and event ID are sent from one look; the rest are counted.</summary>
    public const int MaxPerSourcePerLook = 20;

    /// <summary>
    /// Any user at the cabinet can write to the Application log, so a flood of entries must not push real problems out of
    /// the queue: each (source, event ID) sends at most 20 entries per look, and one summary event says how many more there
    /// were. When more entries arrived than one look reads, the summary says so too, rather than dropping them silently.
    /// </summary>
    private static IReadOnlyList<AgentEvent> Limit(string log, List<EventSummary> ordered, bool pagesExhausted, DateTimeOffset now)
    {
        var events = new List<AgentEvent>();
        var skipped = new Dictionary<(string Source, int Id), int>();
        var sent = new Dictionary<(string Source, int Id), int>();
        foreach (var e in ordered)
        {
            var key = (e.Source, e.EventId);
            sent.TryGetValue(key, out int n);
            if (n < MaxPerSourcePerLook) { events.Add(ToEvent(log, e)); sent[key] = n + 1; }
            else skipped[key] = skipped.GetValueOrDefault(key) + 1;
        }
        foreach (var ((source, id), count) in skipped.OrderByDescending(k => k.Value).Take(10))
            events.Add(Summary(log, now, $"{count} more entries from {source} (event {id}) were not sent: the log is being flooded.",
                new Dictionary<string, string> { ["log"] = log, ["source"] = Helpers.EventText.ShortText(source), ["eventId"] = id.ToString(System.Globalization.CultureInfo.InvariantCulture), ["skipped"] = count.ToString(System.Globalization.CultureInfo.InvariantCulture) }));
        if (pagesExhausted)
            events.Add(Summary(log, now, $"More than {PageSize * MaxPagesPerLook} new entries arrived in {log} since the last look; older ones were not read.",
                new Dictionary<string, string> { ["log"] = log, ["overflow"] = "true" }));
        return events;
    }

    private static AgentEvent Summary(string log, DateTimeOffset now, string message, Dictionary<string, string> fields) => new()
    {
        EventId = EventIds.For($"flood|{log}|{now.ToUnixTimeMilliseconds()}|{message}"),
        Kind = EventKind.AgentStatus,
        OccurredAt = now,
        SeverityHint = SeverityHint.Minor,
        Detail = new EventDetail { Message = Helpers.EventText.ShortText(message), Fields = fields },
    };

    public static AgentEvent ToEvent(string log, EventSummary e) => new()
    {
        EventId = EventIds.For($"eventlog|{log}|{e.RecordId}|{e.Time.ToUnixTimeMilliseconds()}"),
        Kind = EventKind.Error,
        OccurredAt = e.Time,
        Source = new EventSource { Log = log, Source = e.Source, EventId = e.EventId, Level = e.Level, RecordId = e.RecordId },
        SeverityHint = e.Level == EventLevel.Critical ? SeverityHint.Major : SeverityHint.Minor,
        // Kernel-Power 41 carries the fields that tell a blue screen from a held power button (D19); every other entry sends none.
        Detail = new EventDetail { Message = e.FirstLine, Fields = e.Fields is { Count: > 0 } f ? new Dictionary<string, string>(f) : null },
    };
}
