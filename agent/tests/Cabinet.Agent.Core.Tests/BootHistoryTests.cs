using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

/// <summary>boot.history from System log entries: each start with how the run before it ended, its length, and the cause of an unexpected end.</summary>
public sealed class BootHistoryTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 1, 8, 0, 0, TimeSpan.Zero);
    private static long _record = 1000;
    private static EventSummary E(string source, int id, DateTimeOffset at, string line = "", Dictionary<string, string>? fields = null) => new()
    {
        RecordId = Interlocked.Increment(ref _record), Time = at, Level = EventLevel.Information, Source = source, EventId = id, FirstLine = line, Fields = fields,
    };
    private static EventSummary Start(DateTimeOffset at) => E("Microsoft-Windows-Kernel-General", 12, at, "The operating system started.");
    private static EventSummary Stop(DateTimeOffset at) => E("Microsoft-Windows-Kernel-General", 13, at, "The operating system is shutting down.");
    private static EventSummary Request(DateTimeOffset at, string line) => E("User32", 1074, at, line);
    private static EventSummary Kp41(DateTimeOffset at, Dictionary<string, string>? f = null) => E("Microsoft-Windows-Kernel-Power", 41, at, "The system has rebooted without cleanly shutting down first.", f);
    private static EventSummary BlueScreen(DateTimeOffset at) => E("BugCheck", 1001, at, "The computer has rebooted from a bugcheck.");

    private static void MatchesContract(BootHistoryOutput o) =>
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.BootHistory), JsonSerializer.SerializeToElement(o, ContractJson.Options)));

    [Fact]
    public void Each_start_says_how_the_run_before_ended_newest_first()
    {
        var h = TimeSpan.FromHours(1);
        var entries = new List<EventSummary>
        {
            Start(T0),                                                                       // oldest: nothing before it in the log
            Stop(T0 + 5 * h), Start(T0 + 5 * h + TimeSpan.FromMinutes(1)),                    // clean, after 5 h
            Request(T0 + 9 * h, "The process C:\\Windows\\servicing\\TrustedInstaller.exe has initiated the restart of this computer"),
            Stop(T0 + 9 * h + TimeSpan.FromSeconds(30)), Start(T0 + 9 * h + TimeSpan.FromMinutes(2)),   // requested
            Start(T0 + 20 * h), Kp41(T0 + 20 * h + TimeSpan.FromSeconds(40)),                 // unexpected, nothing else: power or a hang
            Start(T0 + 30 * h), Kp41(T0 + 30 * h + TimeSpan.FromSeconds(30)), BlueScreen(T0 + 30 * h + TimeSpan.FromSeconds(90)), // a blue screen
            Start(T0 + 40 * h), Kp41(T0 + 40 * h + TimeSpan.FromSeconds(30), new() { ["BugcheckCode"] = "0", ["PowerButtonTimestamp"] = "133457952000000000" }),
        };
        BootHistoryOutput o = BootHistory.Build(entries, 30, T0 + 41 * h, false);
        MatchesContract(o);
        Assert.Equal(6, o.Boots.Count);
        Assert.Equal(new[] { T0 + 40 * h, T0 + 30 * h, T0 + 20 * h, T0 + 9 * h + TimeSpan.FromMinutes(2), T0 + 5 * h + TimeSpan.FromMinutes(1), T0 }, o.Boots.Select(b => b.StartedAt));
        BootRecord forced = o.Boots[0], bug = o.Boots[1], power = o.Boots[2], requested = o.Boots[3], clean = o.Boots[4], oldest = o.Boots[5];
        Assert.Equal((PreviousEnd.Unexpected, UnexpectedCause.ForcedOff), (forced.Previous, forced.Cause!.Value));
        Assert.Equal((PreviousEnd.Unexpected, UnexpectedCause.BugCheck), (bug.Previous, bug.Cause!.Value));
        Assert.Equal((PreviousEnd.Unexpected, UnexpectedCause.PowerLossOrHang), (power.Previous, power.Cause!.Value));
        Assert.Null(power.UptimeBeforeSeconds);
        Assert.Equal(PreviousEnd.Requested, requested.Previous);
        Assert.StartsWith("The process C:\\Windows\\servicing\\TrustedInstaller.exe", requested.Reason);
        Assert.Equal(4 * 3600 - 60 + 30, requested.UptimeBeforeSeconds);   // from the 5 h + 1 min start to the 9 h + 30 s shutdown
        Assert.Equal(PreviousEnd.Clean, clean.Previous);
        Assert.Equal(5 * 3600, clean.UptimeBeforeSeconds);
        Assert.Null(clean.Cause);
        Assert.Equal(PreviousEnd.Unknown, oldest.Previous);
    }

    [Fact]
    public void Entries_from_other_sources_with_the_same_IDs_are_not_starts_or_ends_and_order_does_not_matter()
    {
        var entries = new List<EventSummary>
        {
            E("SomeVendorService", 12, T0), E("SomeVendorService", 41, T0 + TimeSpan.FromHours(2)), E("Evil", 1074, T0 + TimeSpan.FromHours(1), "format c:"),
            Start(T0 + TimeSpan.FromHours(3)), Stop(T0 + TimeSpan.FromHours(2)), Start(T0 + TimeSpan.FromHours(1)),
        };
        var shuffled = entries.OrderBy(e => e.Source.Length).ThenByDescending(e => e.Time).ToList();
        BootHistoryOutput o = BootHistory.Build(shuffled, 7, T0 + TimeSpan.FromHours(4), false);
        MatchesContract(o);
        Assert.Equal(2, o.Boots.Count);
        Assert.Equal(PreviousEnd.Clean, o.Boots[0].Previous);
        Assert.Equal(3600, o.Boots[0].UptimeBeforeSeconds);
        Assert.Null(o.Boots[0].Reason);
    }

    [Fact]
    public void A_cabinet_that_started_more_than_200_times_is_cut_to_the_newest_200_and_says_so()
    {
        var entries = Enumerable.Range(0, 250).Select(i => Start(T0 + TimeSpan.FromMinutes(10 * i))).ToList();
        BootHistoryOutput o = BootHistory.Build(entries, 90, T0 + TimeSpan.FromDays(3), false);
        Assert.Equal(BootHistory.MaxBoots, o.Boots.Count);
        Assert.True(o.Truncated);
        Assert.Equal(T0 + TimeSpan.FromMinutes(10 * 249), o.Boots[0].StartedAt);
        MatchesContract(o);
        Assert.True(BootHistory.Build([], 30, T0, readTruncated: true).Truncated, "a read cut short says so even with nothing found");
    }

    [Fact]
    public void A_long_or_hostile_reason_stays_within_the_contract()
    {
        var entries = new List<EventSummary> { Start(T0), Request(T0 + TimeSpan.FromHours(1), new string('x', 3000) + "\u0000\u2028"), Start(T0 + TimeSpan.FromHours(2)) };
        BootHistoryOutput o = BootHistory.Build(entries, 30, T0 + TimeSpan.FromHours(3), false);
        MatchesContract(o);
        Assert.True(o.Boots[0].Reason!.Length <= 256);
    }

    [Fact]
    public void An_unexpected_end_with_odd_field_values_falls_back_to_the_rules_without_them()
    {
        foreach (string odd in new[] { "", "0x", "0X10", "-1", "nope", "0x0", "000" })
        {
            var entries = new List<EventSummary> { Start(T0), Start(T0 + TimeSpan.FromHours(1)), Kp41(T0 + TimeSpan.FromHours(1) + TimeSpan.FromSeconds(30), new() { ["BugcheckCode"] = odd }) };
            Assert.Equal(UnexpectedCause.PowerLossOrHang, BootHistory.Build(entries, 30, T0 + TimeSpan.FromHours(2), false).Boots[0].Cause);
        }
    }
}
