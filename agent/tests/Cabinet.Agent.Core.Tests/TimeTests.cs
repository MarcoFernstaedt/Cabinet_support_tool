using System.Globalization;
using Cabinet.Agent.Core.Clock;

namespace Cabinet.Agent.Core.Tests;

/// <summary>A cabinet's time zone and Windows Time in memory. Zones are built here, so the tests do not depend on the machine's zone data.</summary>
public sealed class FakeTime : ITimePlatform
{
    public static readonly TimeZoneInfo Pacific = TimeZoneInfo.CreateCustomTimeZone("Pacific Standard Time", TimeSpan.FromHours(-8), "(UTC-08:00) Pacific Time (US & Canada)", "Pacific Standard Time");
    public static readonly TimeZoneInfo Arizona = TimeZoneInfo.CreateCustomTimeZone("US Mountain Standard Time", TimeSpan.FromHours(-7), "(UTC-07:00) Arizona", "US Mountain Standard Time");
    public static readonly TimeZoneInfo Eastern = TimeZoneInfo.CreateCustomTimeZone("Eastern Standard Time", TimeSpan.FromHours(-5), "(UTC-05:00) Eastern Time (US & Canada)", "Eastern Standard Time");
    private static readonly Dictionary<string, TimeZoneInfo> Known = new[] { Pacific, Arizona, Eastern }.ToDictionary(z => z.Id);

    public TimeZoneInfo Zone { get; set; } = Pacific;
    public TimeServiceState Service { get; set; } = TimeServiceState.Running;
    public string? Status { get; set; } = "Leap Indicator: 0(no warning)\r\nSource: time.windows.com,0x9\r\nLast Successful Sync Time: 10/8/2026 2:00:00 AM\r\n";
    public int SetZoneExit { get; set; }
    public bool SetZoneIgnored { get; set; }
    public int ResyncExit { get; set; }
    public List<string> Calls { get; } = [];

    public TimeZoneInfo CurrentZone() => Zone;
    public DateTimeOffset UtcNow() => new(2026, 10, 10, 16, 15, 2, 345, TimeSpan.Zero);
    public TimeServiceState ServiceState() => Service;
    public string? QueryStatus() => Status;
    public bool PolicyManaged() => false;

    public int SetZone(string timeZoneId)
    {
        Calls.Add($"tzutil /s {timeZoneId}");
        if (SetZoneExit == 0 && !SetZoneIgnored) Zone = Known[timeZoneId];
        return SetZoneExit;
    }

    public int Resync()
    {
        Calls.Add("w32tm /resync");
        if (ResyncExit == 0) Status = "Source: time.windows.com,0x9\nLast Successful Sync Time: 10/10/2026 9:15:10 AM\n";
        return ResyncExit;
    }
}

public sealed class TimeTests
{
    private static readonly CultureInfo Us = CultureInfo.GetCultureInfo("en-US");
    private static (TimeOperations Ops, OperationRegistry Registry) Make(FakeTime t)
    {
        var ops = new TimeOperations(t, _ => { }, Us);
        return (ops, ops.Register(new OperationRegistry()));
    }

    private static async Task<(JsonElement? Output, ResultError? Error)> Run(OperationRegistry r, string op, object parameters) =>
        await OperationRunner.RunAsync(r, op, JsonSerializer.SerializeToElement(parameters), TimeSpan.FromSeconds(5), CancellationToken.None);

    [Fact]
    public async Task Status_reports_the_zone_the_clock_and_windows_time_within_the_contract()
    {
        var (_, registry) = Make(new FakeTime());
        var (output, error) = await Run(registry, Catalog.TimeStatus, new { });
        Assert.Null(error);
        var o = output!.Value;
        Assert.Equal("Pacific Standard Time", o.GetProperty("timeZoneId").GetString());
        Assert.Equal(-480, o.GetProperty("utcOffsetMinutes").GetInt32());
        Assert.Equal("2026-10-10T08:15:02", o.GetProperty("localTime").GetString());
        Assert.Equal("synced", o.GetProperty("sync").GetProperty("state").GetString());
        Assert.Equal("time.windows.com,0x9", o.GetProperty("sync").GetProperty("source").GetString());
        // 2:00 AM Pacific (UTC-8) is 10:00 UTC.
        Assert.Equal("2026-10-08T10:00:00Z", o.GetProperty("sync").GetProperty("lastSuccessfulSync").GetString());
    }

    [Theory]
    [InlineData("Source: Local CMOS Clock\nLast Successful Sync Time: unspecified\n", TimeSyncState.NeverSynced)]
    [InlineData("Quelle: time.windows.com\nLetzte erfolgr. Synchronisierung: 10.10.2026 09:15:10\n", TimeSyncState.Unknown)]
    [InlineData("Last Successful Sync Time: not a date\n", TimeSyncState.Unknown)]
    [InlineData("", TimeSyncState.Unknown)]
    [InlineData(null, TimeSyncState.Unknown)]
    public void Windows_time_status_that_cannot_be_read_is_unknown_never_guessed(string? text, TimeSyncState expected)
    {
        TimeSync s = TimeRules.ParseStatus(text, FakeTime.Pacific, Us);
        Assert.Equal(expected, s.State);
        if (expected != TimeSyncState.Synced) Assert.Null(s.LastSuccessfulSync);
    }

    [Fact]
    public void A_hostile_source_line_is_cleaned_to_one_short_line()
    {
        TimeSync s = TimeRules.ParseStatus("Source: evil\u0007" + new string('x', 400) + "\nLast Successful Sync Time: unspecified", FakeTime.Pacific, Us);
        Assert.DoesNotContain('\u0007', s.Source!);
        Assert.True(s.Source!.Length <= 256);
    }

    [Fact]
    public async Task Set_zone_runs_tzutil_with_the_checked_zone_and_reports_before_and_after()
    {
        var t = new FakeTime();
        var (_, registry) = Make(t);
        var (output, error) = await Run(registry, Catalog.TimeSetZone, new { timeZoneId = "US Mountain Standard Time" });
        Assert.Null(error);
        Assert.Equal("Pacific Standard Time", output!.Value.GetProperty("before").GetString());
        Assert.Equal("US Mountain Standard Time", output.Value.GetProperty("after").GetString());
        Assert.Equal(["tzutil /s US Mountain Standard Time"], t.Calls);
    }

    [Fact]
    public async Task Setting_the_zone_it_already_has_changes_nothing()
    {
        var t = new FakeTime { Zone = FakeTime.Arizona };
        var (_, registry) = Make(t);
        var (output, _) = await Run(registry, Catalog.TimeSetZone, new { timeZoneId = "US Mountain Standard Time" });
        Assert.Equal("US Mountain Standard Time", output!.Value.GetProperty("after").GetString());
        Assert.Empty(t.Calls);
    }

    [Theory]
    [InlineData("UTC")]
    [InlineData("Eastern Standard Time /s UTC")]
    [InlineData("eastern standard time")]
    [InlineData("")]
    public void Zones_outside_the_compiled_list_never_reach_tzutil(string zone)
    {
        var t = new FakeTime();
        var (ops, _) = Make(t);
        var e = Assert.Throws<OperationFailedException>(() => ops.SetZone(new TimeSetZoneParams { TimeZoneId = zone }));
        Assert.Equal("execution_failed", e.Code); // invalid_params is not a failure code; the agent reports it as a failed run
        Assert.Empty(t.Calls);
    }

    [Fact]
    public async Task A_zone_change_windows_did_not_make_is_a_failure_not_a_success()
    {
        var (_, registry) = Make(new FakeTime { SetZoneIgnored = true });
        var (_, error) = await Run(registry, Catalog.TimeSetZone, new { timeZoneId = "Eastern Standard Time" });
        Assert.Equal("execution_failed", error!.Code);
    }

    [Fact]
    public async Task Sync_reports_the_new_last_sync_time()
    {
        var t = new FakeTime();
        var (_, registry) = Make(t);
        var (output, error) = await Run(registry, Catalog.TimeSync, new { });
        Assert.Null(error);
        Assert.Equal("synced", output!.Value.GetProperty("result").GetString());
        Assert.Equal("2026-10-08T10:00:00Z", output.Value.GetProperty("lastSuccessfulSyncBefore").GetString());
        Assert.Equal("2026-10-10T17:15:10Z", output.Value.GetProperty("lastSuccessfulSyncAfter").GetString());
    }

    [Fact]
    public async Task Sync_with_windows_time_stopped_tries_nothing()
    {
        var t = new FakeTime { Service = TimeServiceState.Stopped };
        var (_, registry) = Make(t);
        var (output, _) = await Run(registry, Catalog.TimeSync, new { });
        Assert.Equal("service_stopped", output!.Value.GetProperty("result").GetString());
        Assert.Empty(t.Calls);
    }

    [Fact]
    public async Task A_sync_no_source_answered_is_reported_as_failed()
    {
        var (_, registry) = Make(new FakeTime { ResyncExit = 1 });
        var (output, _) = await Run(registry, Catalog.TimeSync, new { });
        Assert.Equal("failed", output!.Value.GetProperty("result").GetString());
    }

    [Theory]
    [InlineData("Pacific Standard Time", true)]
    [InlineData("UTC", true)]
    [InlineData("Pacific\"; tzutil /s UTC", false)]
    [InlineData("", false)]
    public void Only_plain_zone_ids_are_reported_in_the_heartbeat(string id, bool reportable) =>
        Assert.Equal(reportable, TimeRules.IsReportable(id));
}
