using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// The change watcher (docs/spec/13-roadmap.md phase 2): system changes become <c>change</c> events as they happen, so the
/// platform knows what changed on a cabinet before it crashed, even when the cabinet can no longer boot afterwards.
/// Updates installed, drivers and services installed, software installed or removed, Windows starting and shutting down,
/// and restarts with who asked for them. Only the fixed list below (log, source, event ID) is read; Error and Critical
/// entries are left to the error watcher, which already reports them. A first look goes back 14 days.
/// </summary>
public sealed class ChangeWatch(StateFile<EventLogWatch.State> store, Func<EventlogQueryParams, CancellationToken, Task<EventlogQueryOutput>> query)
{
    public sealed record Watched(string Log, string Source, int EventId);

    /// <summary>The changes collected. Compared exactly (source names ignore case, as Windows does); no patterns.</summary>
    public static readonly IReadOnlyList<Watched> List =
    [
        new("System", "Microsoft-Windows-WindowsUpdateClient", 19),   // update installed
        new("System", "Microsoft-Windows-WindowsUpdateClient", 43),   // update installation started
        new("System", "Microsoft-Windows-Kernel-General", 12),        // Windows started
        new("System", "Microsoft-Windows-Kernel-General", 13),        // Windows shut down
        new("System", "EventLog", 6005),                              // event log service started (boot)
        new("System", "EventLog", 6006),                              // event log service stopped (clean shutdown)
        new("System", "User32", 1074),                                // a restart or shutdown was requested, and by what
        new("System", "Service Control Manager", 7045),               // a service was installed
        new("System", "Microsoft-Windows-UserPnp", 20001),            // a driver was installed for a device
        new("System", "Microsoft-Windows-UserPnp", 20003),            // a driver service was added
        new("Application", "MsiInstaller", 11707),                    // software installed
        new("Application", "MsiInstaller", 11724),                    // software removed
        new("Application", "MsiInstaller", 1033),                     // software installed (product record)
        new("Application", "MsiInstaller", 1034),                     // software removed (product record)
    ];

    public static readonly TimeSpan FirstLookBack = TimeSpan.FromDays(14);
    public const int PageSize = 100;
    public const int MaxPagesPerLook = 5;

    public static bool IsWatched(string log, EventSummary e) =>
        e.Level is not (EventLevel.Error or EventLevel.Critical)
        && List.Any(w => w.Log == log && w.EventId == e.EventId && string.Equals(w.Source, e.Source, StringComparison.OrdinalIgnoreCase));

    public async Task<IReadOnlyList<AgentEvent>> CheckAsync(string log, DateTimeOffset now, CancellationToken token)
    {
        int[] ids = List.Where(w => w.Log == log).Select(w => w.EventId).Distinct().ToArray();
        if (ids.Length == 0) return [];
        EventLogWatch.State state = store.Load();
        string key = "changes|" + log;
        state.Logs.TryGetValue(key, out EventLogWatch.Bookmark? mark);
        DateTimeOffset from = mark is null ? now - FirstLookBack : mark.Time - TimeSpan.FromMinutes(5);
        var fresh = new List<EventSummary>();
        long? before = null;
        for (int page = 0; page < MaxPagesPerLook; page++)
        {
            var output = await query(new EventlogQueryParams { Log = log, EventIds = ids, From = from, BeforeRecordId = before, PageSize = PageSize }, token).ConfigureAwait(false);
            var newer = output.Entries.Where(e => mark is null || e.RecordId > mark.RecordId).ToList();
            fresh.AddRange(newer);
            if (newer.Count < output.Entries.Count || output.NextBeforeRecordId is null) break;
            before = output.NextBeforeRecordId;
        }
        var ordered = fresh.GroupBy(e => e.RecordId).Select(g => g.First()).OrderBy(e => e.RecordId).ToList();
        if (ordered.Count > 0 || mark is null)
        {
            state.Logs[key] = ordered.Count > 0 ? new EventLogWatch.Bookmark { RecordId = ordered[^1].RecordId, Time = ordered.Max(e => e.Time) }
                : new EventLogWatch.Bookmark { RecordId = 0, Time = now };
            store.Save(state);
        }
        return ordered.Where(e => IsWatched(log, e)).Select(e => ToEvent(log, e)).ToList();
    }

    public static AgentEvent ToEvent(string log, EventSummary e) => new()
    {
        EventId = EventIds.For($"change|{log}|{e.RecordId}|{e.Time.ToUnixTimeMilliseconds()}"),
        Kind = EventKind.Change,
        OccurredAt = e.Time,
        Source = new EventSource { Log = log, Source = e.Source, EventId = e.EventId, Level = e.Level, RecordId = e.RecordId },
        SeverityHint = SeverityHint.Minor,
        Detail = new EventDetail { Message = e.FirstLine },
    };
}
