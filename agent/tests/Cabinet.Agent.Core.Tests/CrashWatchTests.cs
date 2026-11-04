using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

/// <summary>The new-dump and short-uptime monitors: each finding reported once, the first look bounded, and every event within its contract.</summary>
public sealed class CrashWatchTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 3, 12, 0, 0, TimeSpan.Zero);

    private static MinidumpInfo Dump(string name, double hoursAgo, long? stop = 0xD1) => new()
    {
        Name = name, WrittenAt = Now.AddHours(-hoursAgo), SizeBytes = 1_048_576, StopCode = stop,
        Parameters = stop is null ? null : ["0x0000000000000028", "0x0000000000000002", "0x0000000000000000", "0xFFFFF8063C41A2B0"],
        Problem = stop is null ? DumpProblem.TooShort : null,
    };

    private static CrashListOutput Dumps(params MinidumpInfo[] d) =>
        new() { TakenAt = Now, FolderFound = true, Minidumps = d.OrderByDescending(x => x.WrittenAt).ToList(), MemoryDump = null, Truncated = false };

    [Fact]
    public void The_first_look_reports_only_the_last_day_s_dumps_and_later_looks_only_new_ones()
    {
        var w = new DumpWatch(new StateFile<DumpWatch.State>(null));
        var first = w.Check(Dumps(Dump("old.dmp", 72), Dump("recent.dmp", 2)), Now);
        Assert.Equal(["recent.dmp"], first.Select(e => e.Detail.Fields!["dump"]));
        Assert.Empty(w.Check(Dumps(Dump("old.dmp", 72), Dump("recent.dmp", 2)), Now));
        // A dump that appears later is reported once, even if Windows dated it before the last look.
        var next = w.Check(Dumps(Dump("old.dmp", 72), Dump("recent.dmp", 2), Dump("new.dmp", 30)), Now);
        var e = Assert.Single(next);
        Assert.Equal(EventKind.CrashDump, e.Kind);
        Assert.Equal(SeverityHint.Major, e.SeverityHint);
        Assert.Equal("0x000000D1", e.Detail.Fields!["stopCode"]);
        Assert.Equal("0xFFFFF8063C41A2B0", e.Detail.Fields["parameter4"]);
        Assert.True(EventQueueTests.Valid(e));
        Assert.Empty(w.Check(Dumps(Dump("recent.dmp", 2), Dump("new.dmp", 30)), Now));
    }

    [Fact]
    public void A_dump_whose_header_could_not_be_read_is_still_reported_with_why()
    {
        var w = new DumpWatch(new StateFile<DumpWatch.State>(null));
        var e = Assert.Single(w.Check(Dumps(Dump("cut.dmp", 1, stop: null)), Now));
        Assert.Equal("too_short", e.Detail.Fields!["problem"]);
        Assert.False(e.Detail.Fields.ContainsKey("stopCode"));
        Assert.True(EventQueueTests.Valid(e));
    }

    [Fact]
    public void A_folder_full_of_new_dumps_is_sent_ten_a_look_oldest_first_and_none_is_lost()
    {
        var w = new DumpWatch(new StateFile<DumpWatch.State>(null));
        var dumps = Dumps(Enumerable.Range(0, 30).Select(i => Dump($"d{i:00}.dmp", 0.5 + i * 0.1)).ToArray());
        var sent = new List<string>();
        for (int look = 0; look < 3; look++)
        {
            var events = w.Check(dumps, Now);
            Assert.Equal(DumpWatch.MaxEventsPerLook, events.Count);
            sent.AddRange(events.Select(e => e.Detail.Fields!["dump"]));
        }
        Assert.Empty(w.Check(dumps, Now));
        Assert.Equal(30, sent.Distinct().Count());
        Assert.Equal("d29.dmp", sent[0]);   // the oldest goes first, so the events stay in the order the crashes happened
        Assert.Equal("d00.dmp", sent[^1]);
    }

    [Fact]
    public void Old_dumps_the_first_look_leaves_out_stay_out_while_overflow_is_carried()
    {
        var w = new DumpWatch(new StateFile<DumpWatch.State>(null));
        var dumps = Dumps([Dump("old.dmp", 72), .. Enumerable.Range(0, 12).Select(i => Dump($"n{i:00}.dmp", 1 + i * 0.1))]);
        Assert.Equal(10, w.Check(dumps, Now).Count);
        Assert.Equal(["n01.dmp", "n00.dmp"], w.Check(dumps, Now).Select(e => e.Detail.Fields!["dump"]));
        Assert.Empty(w.Check(dumps, Now));
    }

    [Fact]
    public void A_dump_dated_in_the_future_is_reported_at_the_time_of_the_look()
    {
        var w = new DumpWatch(new StateFile<DumpWatch.State>(null));
        var e = Assert.Single(w.Check(Dumps(Dump("ahead.dmp", -3)), Now));
        Assert.Equal(Now, e.OccurredAt);
    }

    [Fact]
    public void What_has_been_seen_survives_a_restart_of_the_agent()
    {
        using var dir = new TempDir();
        string path = Path.Combine(dir.Path, "dumps.json");
        Assert.Single(new DumpWatch(new StateFile<DumpWatch.State>(path)).Check(Dumps(Dump("a.dmp", 1)), Now));
        Assert.Empty(new DumpWatch(new StateFile<DumpWatch.State>(path)).Check(Dumps(Dump("a.dmp", 1)), Now));
    }

    private static BootRecord Boot(double minutesAgo, PreviousEnd previous = PreviousEnd.Unexpected, long? uptimeBefore = null, UnexpectedCause? cause = null) => new()
    {
        StartedAt = Now.AddMinutes(-minutesAgo), Previous = previous, PreviousEndedAt = null, UptimeBeforeSeconds = uptimeBefore, Reason = null, Cause = cause,
    };

    private static BootHistoryOutput Boots(params BootRecord[] b) => new() { TakenAt = Now, Days = 2, Boots = b, Truncated = false };

    [Fact]
    public void A_start_that_followed_a_short_run_is_reported_once_with_how_the_run_ended()
    {
        var w = new UptimeWatch(new StateFile<UptimeWatch.State>(null));
        // Newest first: started 5 minutes ago after a 4-minute run that ended in a blue screen; that run followed a 3-hour one.
        var history = Boots(Boot(5, cause: UnexpectedCause.BugCheck), Boot(9, PreviousEnd.Clean, uptimeBefore: 3 * 3600), Boot(200));
        var e = Assert.Single(w.Check(history, Now));
        Assert.Equal(EventKind.ShortUptime, e.Kind);
        Assert.Equal("240", e.Detail.Fields!["ranSeconds"]);
        Assert.Equal("unexpected", e.Detail.Fields["previousEnd"]);
        Assert.Equal("bug_check", e.Detail.Fields["cause"]);
        Assert.Equal(Now.AddMinutes(-5), e.OccurredAt);
        Assert.True(EventQueueTests.Valid(e));
        Assert.Empty(w.Check(history, Now));
    }

    [Fact]
    public void The_uptime_Windows_logged_is_used_before_the_gap_between_starts()
    {
        var w = new UptimeWatch(new StateFile<UptimeWatch.State>(null));
        // 30 minutes between the starts, but Windows logged a clean shutdown after 10 of them (it sat off for the rest).
        var e = Assert.Single(w.Check(Boots(Boot(10, PreviousEnd.Clean, uptimeBefore: 600), Boot(40)), Now));
        Assert.Equal("600", e.Detail.Fields!["ranSeconds"]);
        Assert.False(e.Detail.Fields.ContainsKey("cause"));
        Assert.True(EventQueueTests.Valid(e));
    }

    [Theory]
    [InlineData(UptimeWatch.ShortRunSeconds - 1, 1)]
    [InlineData(UptimeWatch.ShortRunSeconds, 0)]
    [InlineData(-5, 0)]
    public void Only_runs_under_the_limit_count(long uptimeBefore, int expected)
    {
        var w = new UptimeWatch(new StateFile<UptimeWatch.State>(null));
        Assert.Equal(expected, w.Check(Boots(Boot(30, PreviousEnd.Requested, uptimeBefore: uptimeBefore), Boot(200)), Now).Count);
    }

    [Fact]
    public void The_first_look_checks_only_the_last_day_and_the_oldest_start_is_never_judged()
    {
        var w = new UptimeWatch(new StateFile<UptimeWatch.State>(null));
        // Two days ago: two starts 5 minutes apart, before the first look's day. The oldest start has no run before it to measure.
        Assert.Empty(w.Check(Boots(Boot(47 * 60), Boot(47 * 60 + 5)), Now));
        Assert.Empty(new UptimeWatch(new StateFile<UptimeWatch.State>(null)).Check(Boots(Boot(3)), Now));
    }

    [Fact]
    public void A_boot_loop_gives_one_event_per_short_run_oldest_first_and_new_starts_later()
    {
        var w = new UptimeWatch(new StateFile<UptimeWatch.State>(null));
        var events = w.Check(Boots(Boot(2), Boot(6), Boot(10), Boot(14), Boot(300)), Now);
        Assert.Equal([Now.AddMinutes(-10), Now.AddMinutes(-6), Now.AddMinutes(-2)], events.Select(e => e.OccurredAt));
        var later = w.Check(Boots(Boot(1), Boot(2), Boot(6), Boot(10), Boot(14), Boot(300)), Now);
        Assert.Equal(Now.AddMinutes(-1), Assert.Single(later).OccurredAt);
    }

    [Fact]
    public void A_long_boot_loop_is_sent_ten_a_look_oldest_first_and_none_is_lost()
    {
        var w = new UptimeWatch(new StateFile<UptimeWatch.State>(null));
        // 16 starts 3 minutes apart: 15 short runs, then the run before the oldest start, which is not judged.
        var history = Boots(Enumerable.Range(0, 16).Select(i => Boot(1 + i * 3)).ToArray());
        var first = w.Check(history, Now);
        Assert.Equal(UptimeWatch.MaxEventsPerLook, first.Count);
        Assert.Equal(Now.AddMinutes(-43), first[0].OccurredAt);
        var second = w.Check(history, Now);
        Assert.Equal(5, second.Count);
        Assert.Equal(Now.AddMinutes(-1), second[^1].OccurredAt);
        Assert.Equal(15, first.Concat(second).Select(e => e.OccurredAt).Distinct().Count());
        Assert.Empty(w.Check(history, Now));
    }

    [Fact]
    public void A_start_dated_far_in_the_future_is_ignored()
    {
        var w = new UptimeWatch(new StateFile<UptimeWatch.State>(null));
        Assert.Empty(w.Check(Boots(Boot(-600), Boot(200)), Now));
        // and it does not move the bookmark past real starts
        Assert.Single(w.Check(Boots(Boot(-600), Boot(3), Boot(8)), Now));
    }
}
