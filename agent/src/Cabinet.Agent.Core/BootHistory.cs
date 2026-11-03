using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core;

/// <summary>
/// boot.history from System log entries (roadmap phase 2): each start (Kernel-General 12), how the run before it ended, and how long that run
/// lasted. Pure: the Windows side only reads the entries. An end is:
/// - clean: Kernel-General 13 (Windows shut down) between the two starts;
/// - requested: User32 1074 (a restart or shutdown was asked for), with its first line as the reason;
/// - unexpected: Kernel-Power 41 or EventLog 6008 logged as the start happened, with its cause from its own fields or a BugCheck 1001
///   within 10 minutes (decision-log D19);
/// - unknown: none of these, for example the oldest start in the log.
/// </summary>
public static class BootHistory
{
    public const int DefaultDays = 30, MaxBoots = 200;
    /// <summary>The event IDs read from the System log; the sources are checked here.</summary>
    public static readonly IReadOnlyList<int> EventIds = [12, 13, 41, 1001, 1074, 6008];
    /// <summary>Entries logged at a start (Kernel-Power 41, 6008, the blue screen's 1001) can trail it by a few minutes.</summary>
    public static readonly TimeSpan AfterStart = TimeSpan.FromMinutes(10);
    /// <summary>A record written at a start can carry a time a little before Kernel-General 12's.</summary>
    public static readonly TimeSpan StartSkew = TimeSpan.FromMinutes(1);

    private static bool Is(EventSummary e, string source, int id) => e.EventId == id && string.Equals(e.Source, source, StringComparison.OrdinalIgnoreCase);
    private static bool IsStart(EventSummary e) => Is(e, "Microsoft-Windows-Kernel-General", 12);
    private static bool IsShutdown(EventSummary e) => Is(e, "Microsoft-Windows-Kernel-General", 13);
    private static bool IsRequest(EventSummary e) => Is(e, "User32", 1074);
    private static bool IsUnexpected(EventSummary e) => Is(e, KernelPowerFields.Provider, KernelPowerFields.EventId) || Is(e, "EventLog", 6008);
    private static bool IsBlueScreen(EventSummary e) => Is(e, "BugCheck", 1001) || Is(e, "Microsoft-Windows-WER-SystemErrorReporting", 1001);

    public static BootHistoryOutput Build(IEnumerable<EventSummary> entries, int days, DateTimeOffset now, bool readTruncated)
    {
        var all = entries.OrderBy(e => e.Time).ThenBy(e => e.RecordId).ToList();
        var starts = all.Where(IsStart).ToList();
        // Each record written at a start is given to its one owner first, so two starts minutes apart (a crash loop) never share or lose one.
        var atStarts = starts.Select(_ => new List<EventSummary>()).ToList();
        foreach (EventSummary e in all.Where(e => IsUnexpected(e) || IsBlueScreen(e)))
            if (OwnerOf(e.Time, starts) is int owner) atStarts[owner].Add(e);
        var boots = new List<BootRecord>(starts.Count);
        for (int i = 0; i < starts.Count; i++)
        {
            EventSummary start = starts[i];
            EventSummary? before = i > 0 ? starts[i - 1] : null;
            // A shutdown or a restart request belongs to the run before: between the previous start and this one. A record written as
            // Windows starts again (Kernel-Power 41, 6008, a blue screen's 1001) belongs to exactly one start: see OwnerOf.
            DateTimeOffset from = before?.Time ?? DateTimeOffset.MinValue;
            var ranBefore = all.Where(e => e.Time > from && e.Time <= start.Time && !ReferenceEquals(e, start)).ToList();
            var atStart = atStarts[i];

            EventSummary? unexpected = atStart.FirstOrDefault(IsUnexpected);
            EventSummary? shutdown = ranBefore.LastOrDefault(IsShutdown);
            EventSummary? request = ranBefore.LastOrDefault(IsRequest);
            PreviousEnd kind; DateTimeOffset? endedAt = null; string? reason = null; UnexpectedCause? cause = null;
            if (unexpected is not null)
            {
                kind = PreviousEnd.Unexpected;
                cause = CauseOf(unexpected, atStart.Where(IsBlueScreen));
            }
            else if (request is not null) { kind = PreviousEnd.Requested; endedAt = (shutdown ?? request).Time; reason = Short(request.FirstLine); }
            else if (shutdown is not null) { kind = PreviousEnd.Clean; endedAt = shutdown.Time; }
            else kind = PreviousEnd.Unknown;

            long? uptime = before is not null && endedAt is { } end && end >= before.Time ? (long)Math.Floor((end - before.Time).TotalSeconds) : null;
            boots.Add(new BootRecord { StartedAt = start.Time, Previous = kind, PreviousEndedAt = endedAt, UptimeBeforeSeconds = uptime, Reason = reason, Cause = cause });
        }
        boots.Reverse();
        bool truncated = readTruncated || boots.Count > MaxBoots;
        return new BootHistoryOutput { TakenAt = now, Days = days, Boots = boots.Take(MaxBoots).ToList(), Truncated = truncated };
    }

    /// <summary>
    /// Which start a record written as Windows starts again belongs to: the latest start at or before the record's time plus StartSkew (so a
    /// record stamped a little before its own start's Kernel-General 12 is still that start's), and only if the record is no more than
    /// AfterStart after it. Otherwise no start owns it. `starts` are oldest first.
    /// </summary>
    public static int? OwnerOf(DateTimeOffset at, IReadOnlyList<EventSummary> starts)
    {
        for (int i = starts.Count - 1; i >= 0; i--)
        {
            if (starts[i].Time - StartSkew > at) continue;
            return at - starts[i].Time <= AfterStart ? i : null;
        }
        return null;
    }

    /// <summary>The event's own fields first (Kernel-Power 41), then a blue screen within 10 minutes, else power lost or a hang (D19).</summary>
    public static UnexpectedCause CauseOf(EventSummary unexpected, IEnumerable<EventSummary> blueScreens)
    {
        if (unexpected.Fields is { } f)
        {
            if (f.TryGetValue("BugcheckCode", out string? b) && NonZero(b)) return UnexpectedCause.BugCheck;
            if (f.TryGetValue("PowerButtonTimestamp", out string? p) && NonZero(p)) return UnexpectedCause.ForcedOff;
        }
        return blueScreens.Any(s => (s.Time - unexpected.Time).Duration() <= AfterStart) ? UnexpectedCause.BugCheck : UnexpectedCause.PowerLossOrHang;
    }

    /// <summary>A plain number (KernelPowerFields' rule) other than zero; a value too large for 64 bits is still a non-zero number.</summary>
    private static bool NonZero(string v)
    {
        if (!KernelPowerFields.IsNumber(v)) return false;
        string digits = v.StartsWith("0x", StringComparison.Ordinal) ? v[2..] : v;
        return digits.Any(c => c != '0');
    }

    private static string? Short(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;
        string t = EventText.ShortText(line.Trim());
        return t.Length > 256 ? t[..256] : t;
    }
}
