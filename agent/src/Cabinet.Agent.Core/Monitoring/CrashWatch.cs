using System.Globalization;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// New crash dumps (docs/spec/13-roadmap.md phase 2, agent monitors). Each look is a crash.list read; a dump whose name was not there
/// last time is reported once, with the stop code and parameters its header gave. The first look after install reports only dumps written
/// in the last day, so an old Minidump folder does not arrive as a flood, while a crash just before the agent started is not lost.
/// </summary>
public sealed class DumpWatch(StateFile<DumpWatch.State> store)
{
    public const int MaxEventsPerLook = 10;
    public static readonly TimeSpan FirstLookWindow = TimeSpan.FromDays(1);

    public sealed class State
    {
        public bool Primed { get; set; }
        public List<string> Seen { get; set; } = new();
    }

    public IReadOnlyList<AgentEvent> Check(CrashListOutput output, DateTimeOffset now)
    {
        State state = store.Load();
        var seen = new HashSet<string>(state.Seen, StringComparer.OrdinalIgnoreCase);
        var fresh = output.Minidumps
            .Where(d => !seen.Contains(d.Name) && (state.Primed || d.WrittenAt >= now - FirstLookWindow))
            .OrderBy(d => d.WrittenAt).ToList();
        // Windows removes old dumps itself, so the names it holds now are all that is kept; a removed name never comes back.
        store.Save(new State { Primed = true, Seen = output.Minidumps.Select(d => d.Name).ToList() });
        return fresh.TakeLast(MaxEventsPerLook).Select(d => Build(d, now)).ToList();
    }

    private static AgentEvent Build(MinidumpInfo d, DateTimeOffset now)
    {
        var fields = new Dictionary<string, string>
        {
            ["dump"] = d.Name,
            ["writtenAt"] = d.WrittenAt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
            ["sizeBytes"] = d.SizeBytes.ToString(CultureInfo.InvariantCulture),
        };
        string stop;
        if (d.StopCode is { } code && d.Parameters is { Count: 4 } p)
        {
            stop = $"0x{code:X8}";
            fields["stopCode"] = stop;
            for (int i = 0; i < 4; i++) fields[$"parameter{i + 1}"] = p[i];
        }
        else
        {
            stop = "not read";
            fields["problem"] = d.Problem is { } problem ? JsonNamingPolicy.SnakeCaseLower.ConvertName(problem.ToString()) : "unreadable";
        }
        return new AgentEvent
        {
            EventId = Guid.NewGuid(), Kind = EventKind.CrashDump, OccurredAt = d.WrittenAt <= now ? d.WrittenAt : now, SeverityHint = SeverityHint.Major,
            Detail = new EventDetail { Message = EventText.ShortText($"A new crash dump: {d.Name}, stop code {stop}."), Fields = fields },
        };
    }
}

/// <summary>
/// Short uptimes (decision-log D20): a start that followed a run shorter than <see cref="ShortRunSeconds"/>. Each look is a boot.history
/// read of the last two days; every start newer than the last one looked at is checked once. A run's length is the uptime Windows
/// logged at a clean or requested shutdown, or else the time between its start and the next (all an unexpected end leaves).
/// The first look after install checks only the last day's starts.
/// </summary>
public sealed class UptimeWatch(StateFile<UptimeWatch.State> store)
{
    /// <summary>20 minutes: three such runs fit in the server's reboot-loop window (3 starts within 60 minutes).</summary>
    public const int ShortRunSeconds = 20 * 60;
    public const int MaxEventsPerLook = 10;

    public sealed class State
    {
        public DateTimeOffset? LastStart { get; set; }
    }

    public IReadOnlyList<AgentEvent> Check(BootHistoryOutput output, DateTimeOffset now)
    {
        State state = store.Load();
        var boots = output.Boots.Where(b => b.StartedAt <= now + TimeSpan.FromMinutes(5)).OrderByDescending(b => b.StartedAt).ToList();
        DateTimeOffset after = state.LastStart ?? now - DumpWatch.FirstLookWindow;
        var events = new List<AgentEvent>();
        for (int i = 0; i + 1 < boots.Count; i++)
        {
            BootRecord start = boots[i], previous = boots[i + 1];
            if (start.StartedAt <= after) break;
            long ran = start.UptimeBeforeSeconds ?? (long)(start.StartedAt - previous.StartedAt).TotalSeconds;
            if (ran < 0 || ran >= ShortRunSeconds) continue;
            events.Add(Build(start, previous, ran));
        }
        if (boots.Count > 0 && (state.LastStart is null || boots[0].StartedAt > state.LastStart))
            store.Save(new State { LastStart = boots[0].StartedAt });
        events.Reverse(); // oldest first, as they happened
        return events.TakeLast(MaxEventsPerLook).ToList();
    }

    private static AgentEvent Build(BootRecord start, BootRecord previous, long ran)
    {
        static string Iso(DateTimeOffset t) => t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        string end = JsonNamingPolicy.SnakeCaseLower.ConvertName(start.Previous.ToString());
        var fields = new Dictionary<string, string>
        {
            ["startedAt"] = Iso(start.StartedAt), ["previousStartedAt"] = Iso(previous.StartedAt),
            ["ranSeconds"] = ran.ToString(CultureInfo.InvariantCulture), ["previousEnd"] = end,
        };
        string why = end;
        if (start.Cause is { } cause)
        {
            fields["cause"] = JsonNamingPolicy.SnakeCaseLower.ConvertName(cause.ToString());
            why = $"{end} ({fields["cause"].Replace('_', ' ')})";
        }
        string minutes = ran < 120 ? $"{ran} seconds" : $"{ran / 60} minutes";
        return new AgentEvent
        {
            EventId = Guid.NewGuid(), Kind = EventKind.ShortUptime, OccurredAt = start.StartedAt, SeverityHint = SeverityHint.Minor,
            Detail = new EventDetail { Message = $"Windows started again after running for {minutes}; the run before ended {why}.", Fields = fields },
        };
    }
}
