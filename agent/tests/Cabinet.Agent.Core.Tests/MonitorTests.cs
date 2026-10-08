using Cabinet.Agent.Core.Helpers;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Tests;

public class EventQueueTests
{
    private static AgentEvent Smart(Guid? id = null) => new()
    {
        EventId = id ?? Guid.NewGuid(), Kind = EventKind.SmartWarning, OccurredAt = Fixtures.Start, SeverityHint = SeverityHint.Major,
        Detail = new EventDetail { Message = "Drive predicts failure." },
    };

    private static bool Valid(AgentEvent e)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(e, ContractJson.Options));
        return ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("event"), doc.RootElement);
    }

    [Fact]
    public void Keeps_events_on_disk_in_order_until_acknowledged()
    {
        using var dir = new TempDir();
        string file = Path.Combine(dir.Path, "events.jsonl");
        var q = new EventQueue(file);
        var ids = Enumerable.Range(0, 150).Select(_ => Guid.NewGuid()).ToList();
        foreach (var id in ids) Assert.True(q.Enqueue(Smart(id)));
        Assert.False(q.Enqueue(Smart(ids[0]))); // the same event is never queued twice

        var reopened = new EventQueue(file);
        var batch = reopened.Peek(500);
        Assert.Equal(EventQueue.MaxBatch, batch.Count); // never more than 100 per send
        Assert.Equal(ids.Take(100), batch.Select(b => b.Id)); // oldest first
        reopened.Acknowledge(batch.Select(b => b.Id));
        Assert.Equal(ids.Skip(100), new EventQueue(file).Peek().Select(b => b.Id));
    }

    [Fact]
    public void Drops_the_oldest_when_full()
    {
        var q = new EventQueue(null);
        var first = Guid.NewGuid();
        q.Enqueue(Smart(first));
        for (int i = 0; i < EventQueue.MaxEvents; i++) q.Enqueue(Smart());
        Assert.Equal(EventQueue.MaxEvents, q.Count);
        Assert.Equal(1, q.Dropped);
        Assert.DoesNotContain(q.Peek(), e => e.Id == first);
    }

    [Fact]
    public void Refuses_an_event_that_breaks_its_contract()
    {
        var q = new EventQueue(null);
        Assert.False(q.Enqueue(Smart() with { Detail = new EventDetail { Message = "bad\u0001control" } }));
        Assert.False(q.Enqueue(Smart() with { Kind = EventKind.Error })); // an error needs its log source
        Assert.False(q.Enqueue(Smart() with { Kind = EventKind.Scanner })); // a scanner event needs its device
        Assert.Equal(0, q.Count);
    }

    [Fact]
    public void A_tampered_or_damaged_queue_file_loses_only_the_bad_lines()
    {
        using var dir = new TempDir();
        string file = Path.Combine(dir.Path, "events.jsonl");
        var good = Smart();
        new EventQueue(file).Enqueue(good);
        File.AppendAllText(file, "not json\n{\"eventId\":\"x\"}\n" + new string('[', 100_000) + "\n" +
            JsonSerializer.Serialize(Smart() with { Kind = EventKind.Error }, ContractJson.Options) + "\n");
        var q = new EventQueue(file);
        Assert.Equal(new[] { good.EventId }, q.Peek().Select(e => e.Id));
    }

    [Fact]
    public void Derived_event_ids_are_stable_and_distinct()
    {
        Assert.Equal(EventIds.For("a"), EventIds.For("a"));
        Assert.NotEqual(EventIds.For("a"), EventIds.For("b"));
        Assert.Matches("^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", EventIds.For("a").ToString());
        Assert.True(Valid(EventLogWatch.ToEvent("System", new EventSummary
        {
            RecordId = 1, Time = Fixtures.Start, Level = EventLevel.Error, Source = "disk", EventId = 7, FirstLine = "bad block",
        })));
    }
}

public class ScannerWatchTests
{
    private static readonly string[] Ids = { @"USB\VID_1234&PID_5678" };

    private static DeviceFacts Scanner(bool present = true, long? problem = 0) => new()
    {
        InstanceId = @"USB\VID_1234&PID_5678\0001", Name = "Fingerprint Reader", Present = present, ProblemCode = problem,
        HardwareIds = new[] { @"USB\VID_1234&PID_5678&REV_0100", @"USB\VID_1234&PID_5678" },
    };

    private static DeviceFacts Mouse() => new() { InstanceId = @"HID\VID_0001", Name = "Mouse", Present = true, HardwareIds = new[] { @"HID\VID_0001" } };

    [Fact]
    public void Raises_on_problem_and_again_on_recovery_but_not_while_it_lasts()
    {
        var w = new ScannerWatch();
        Assert.Null(w.Observe(Ids, new[] { Scanner(), Mouse() }, Fixtures.Start)); // healthy at start: nothing to say
        var gone = w.Observe(Ids, new[] { Mouse() }, Fixtures.Start);
        Assert.Equal(ScannerState.Disconnected, gone!.Device!.State);
        Assert.Equal(SeverityHint.Major, gone.SeverityHint);
        Assert.Null(w.Observe(Ids, new[] { Mouse() }, Fixtures.Start)); // still gone: not repeated
        var back = w.Observe(Ids, new[] { Scanner() }, Fixtures.Start);
        Assert.Equal(ScannerState.Recovered, back!.Device!.State);
        Assert.Contains("disconnected", back.Detail.Message);
    }

    [Fact]
    public void Tells_the_kinds_of_problem_apart()
    {
        Assert.Equal(ScannerWatch.Condition.Disconnected, ScannerWatch.Classify(null));
        Assert.Equal(ScannerWatch.Condition.Disconnected, ScannerWatch.Classify(Scanner(present: false)));
        Assert.Equal(ScannerWatch.Condition.Disconnected, ScannerWatch.Classify(Scanner(problem: 45)));
        Assert.Equal(ScannerWatch.Condition.DriverMissing, ScannerWatch.Classify(Scanner(problem: 28)));
        Assert.Equal(ScannerWatch.Condition.DeviceError, ScannerWatch.Classify(Scanner(problem: 43)));
        Assert.Equal(ScannerWatch.Condition.Ok, ScannerWatch.Classify(Scanner(problem: null)));
    }

    [Fact]
    public void A_different_error_code_is_a_new_problem()
    {
        var w = new ScannerWatch();
        var first = w.Observe(Ids, new[] { Scanner(problem: 10) }, Fixtures.Start);
        Assert.Equal(10, first!.Device!.ProblemCode);
        Assert.Null(w.Observe(Ids, new[] { Scanner(problem: 10) }, Fixtures.Start));
        Assert.Equal(43, w.Observe(Ids, new[] { Scanner(problem: 43) }, Fixtures.Start)!.Device!.ProblemCode);
    }

    [Fact]
    public void Stays_quiet_without_configured_ids_and_restarts_when_they_change()
    {
        var w = new ScannerWatch();
        Assert.Null(w.Observe(null, Array.Empty<DeviceFacts>(), Fixtures.Start));
        Assert.Null(w.Observe(Array.Empty<string>(), Array.Empty<DeviceFacts>(), Fixtures.Start));
        Assert.NotNull(w.Observe(Ids, Array.Empty<DeviceFacts>(), Fixtures.Start));
        // New IDs from the console: a problem with the new scanner is reported, not taken as already known.
        Assert.NotNull(w.Observe(new[] { @"USB\VID_9999&PID_0001" }, Array.Empty<DeviceFacts>(), Fixtures.Start));
    }

    [Fact]
    public void Every_event_it_raises_matches_the_contract()
    {
        var w = new ScannerWatch();
        var events = new[]
        {
            w.Observe(Ids, Array.Empty<DeviceFacts>(), Fixtures.Start),
            w.Observe(Ids, new[] { Scanner(problem: 28) }, Fixtures.Start),
            w.Observe(Ids, new[] { Scanner(problem: 4_294_967_295) }, Fixtures.Start),
            w.Observe(Ids, new[] { Scanner() }, Fixtures.Start),
        };
        var q = new EventQueue(null);
        foreach (var e in events) Assert.True(q.Enqueue(e!));
    }
}

public class DriveWatchTests
{
    private static DriveSmart Drive(long realloc = 0, long pending = 0, int? wear = 10, bool? predict = false, DriveHealth health = DriveHealth.Healthy, int? temp = 35) => new()
    {
        Model = "NVMe 256GB", SerialNumber = "S123", Health = health, PredictFailure = predict, TemperatureCelsius = temp, PowerOnHours = 20000,
        ReallocatedSectors = realloc, PendingSectors = pending, UncorrectableErrors = 0, WearPercent = wear,
    };

    private static DiskSmartOutput Out(params DriveSmart[] d) => new() { Drives = d };

    [Fact]
    public void A_healthy_drive_raises_nothing()
    {
        var w = new DriveWatch(new StateFile<DriveWatch.State>(null));
        Assert.Empty(w.Check(Out(Drive()), Fixtures.Start));
    }

    [Fact]
    public void Warns_early_and_again_only_when_it_gets_worse()
    {
        using var dir = new TempDir();
        var store = new StateFile<DriveWatch.State>(Path.Combine(dir.Path, "drive.json"));
        var e = Assert.Single(new DriveWatch(store).Check(Out(Drive(realloc: 8)), Fixtures.Start));
        Assert.Equal(EventKind.SmartWarning, e.Kind);
        Assert.Equal(SeverityHint.Minor, e.SeverityHint);
        Assert.Equal("reallocated_sectors", e.Detail.Fields!["reasons"]);
        Assert.True(new EventQueue(null).Enqueue(e));

        Assert.Empty(new DriveWatch(store).Check(Out(Drive(realloc: 8)), Fixtures.Start)); // same reading, after a restart
        Assert.Empty(new DriveWatch(store).Check(Out(Drive(realloc: 6)), Fixtures.Start)); // a dip is not news
        var worse = Assert.Single(new DriveWatch(store).Check(Out(Drive(realloc: 12)), Fixtures.Start));
        Assert.Equal("true", worse.Detail.Fields!["worsened"]);
        var failing = Assert.Single(new DriveWatch(store).Check(Out(Drive(realloc: 12, predict: true, health: DriveHealth.Failing)), Fixtures.Start));
        Assert.Equal(SeverityHint.Major, failing.SeverityHint);
    }

    [Theory]
    [InlineData(0, 0, 80, 35, "wear")]
    [InlineData(0, 3, 10, 35, "pending_sectors")]
    [InlineData(0, 0, 10, 61, "temperature")]
    public void Each_early_sign_is_named(long realloc, long pending, int wear, int temp, string reason)
    {
        var w = new DriveWatch(new StateFile<DriveWatch.State>(null));
        Assert.Contains(reason, Assert.Single(w.Check(Out(Drive(realloc, pending, wear, temp: temp)), Fixtures.Start)).Detail.Fields!["reasons"]);
    }

    [Fact]
    public void A_damaged_state_file_starts_fresh()
    {
        using var dir = new TempDir();
        string path = Path.Combine(dir.Path, "drive.json");
        File.WriteAllText(path, "{\"drives\": 42");
        Assert.Single(new DriveWatch(new StateFile<DriveWatch.State>(path)).Check(Out(Drive(realloc: 1)), Fixtures.Start));
    }
}

public class FirewallWatchTests
{
    private static ReportedFirewallRule Rule(string name, FirewallAction action = FirewallAction.Allow, string? ports = "443") => new()
    {
        Name = name, Direction = FirewallDirection.In, Action = action, Protocol = "TCP", LocalPorts = ports, Enabled = true, CreatedByPlatform = false,
    };

    private static FirewallStateOutput State(bool domainOn = true, params ReportedFirewallRule[] rules) => new()
    {
        Profiles = new[]
        {
            new FirewallProfileState { Profile = FirewallProfile.Domain, Enabled = domainOn, DefaultInbound = FirewallAction.Block, DefaultOutbound = FirewallAction.Allow, ReenableAt = null },
        },
        Rules = rules, RulesTruncated = false, Snapshots = Array.Empty<FirewallSnapshotInfo>(),
    };

    [Fact]
    public void The_first_look_is_the_baseline_and_changes_are_described()
    {
        var w = new FirewallWatch(new StateFile<FirewallWatch.State>(null));
        Assert.Null(w.Check(State(true, Rule("A"), Rule("B")), Fixtures.Start));
        Assert.Null(w.Check(State(true, Rule("B"), Rule("A")), Fixtures.Start)); // order does not matter
        var e = w.Check(State(true, Rule("A", ports: "3389"), Rule("C")), Fixtures.Start)!;
        Assert.Equal(EventKind.FirewallChanged, e.Kind);
        Assert.Null(e.CommandId); // nothing the platform did
        Assert.Equal("1", e.Detail.Fields!["added"]);
        Assert.Equal("1", e.Detail.Fields["removed"]);
        Assert.Equal("1", e.Detail.Fields["changed"]);
        Assert.Equal(SeverityHint.Major, e.SeverityHint);
        Assert.True(new EventQueue(null).Enqueue(e));
    }

    [Fact]
    public void Turning_a_profile_off_is_major()
    {
        var w = new FirewallWatch(new StateFile<FirewallWatch.State>(null));
        w.Check(State(true), Fixtures.Start);
        var e = w.Check(State(false), Fixtures.Start)!;
        Assert.Equal(SeverityHint.Major, e.SeverityHint);
        Assert.Contains("profile:Domain", e.Detail.Fields!["changedNames"]);
    }

    [Fact]
    public void Hostile_rule_names_cannot_break_the_event()
    {
        var w = new FirewallWatch(new StateFile<FirewallWatch.State>(null));
        w.Check(State(true), Fixtures.Start);
        var rules = Enumerable.Range(0, 300).Select(i => Rule(new string('x', 250) + i)).Append(Rule("dup")).Append(Rule("dup")).ToArray();
        var e = w.Check(State(true, rules), Fixtures.Start)!;
        Assert.Equal("302", e.Detail.Fields!["added"]);
        Assert.True(e.Detail.Fields["addedNames"].Length <= 256);
        using (var d = JsonDocument.Parse(JsonSerializer.Serialize(e, ContractJson.Options))) Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Envelope("event"), d.RootElement));
        Assert.True(new EventQueue(null).Enqueue(e));
    }
}

public class EventLogWatchTests
{
    private static EventSummary Entry(long id, int minutes, EventLevel level = EventLevel.Error) => new()
    {
        RecordId = id, Time = Fixtures.Start.AddMinutes(minutes), Level = level, Source = "Disk", EventId = 7, FirstLine = "The device has a bad block.",
    };

    [Fact]
    public async Task Reports_each_entry_once_oldest_first()
    {
        var entries = new List<EventSummary> { Entry(5, -60), Entry(6, -30, EventLevel.Critical) };
        var asked = new List<EventlogQueryParams>();
        Task<EventlogQueryOutput> Query(EventlogQueryParams p, CancellationToken _)
        {
            asked.Add(p);
            var page = entries.Where(e => p.BeforeRecordId is null || e.RecordId < p.BeforeRecordId).OrderByDescending(e => e.RecordId).Take(p.PageSize ?? 100).ToList();
            return Task.FromResult(new EventlogQueryOutput { Log = p.Log, Entries = page, NextBeforeRecordId = null, Truncated = false });
        }
        using var dir = new TempDir();
        var store = new StateFile<EventLogWatch.State>(Path.Combine(dir.Path, "b.json"));
        var first = await new EventLogWatch(store, Query).CheckAsync("System", Fixtures.Start, default);
        Assert.Equal(new long[] { 5, 6 }, first.Select(e => e.Source!.RecordId));
        Assert.Equal(SeverityHint.Major, first[1].SeverityHint);
        Assert.Equal(new[] { EventLevel.Critical, EventLevel.Error, EventLevel.Warning }, asked[0].Levels);
        Assert.Equal(Fixtures.Start - EventLogWatch.FirstLookBack, asked[0].From);

        entries.Add(Entry(9, 1));
        var second = await new EventLogWatch(store, Query).CheckAsync("System", Fixtures.Start.AddMinutes(2), default);
        Assert.Equal(new long[] { 9 }, second.Select(e => e.Source!.RecordId));
        Assert.Empty(await new EventLogWatch(store, Query).CheckAsync("System", Fixtures.Start.AddMinutes(4), default));
        var q = new EventQueue(null);
        foreach (var e in first.Concat(second)) Assert.True(q.Enqueue(e));
    }

    [Fact]
    public void Warnings_are_collected_only_from_the_logs_where_hardware_trouble_shows()
    {
        // A retried read (disk 153) or a corrected machine check is a warning; the System log and the hardware logs keep them.
        Assert.Contains(EventLevel.Warning, EventLogWatch.LevelsFor("System"));
        Assert.Contains(EventLevel.Warning, EventLogWatch.LevelsFor("Microsoft-Windows-Kernel-WHEA/Errors"));
        Assert.Contains(EventLevel.Warning, EventLogWatch.LevelsFor("Microsoft-Windows-Storage-Storport/Operational"));
        // Application warnings are mostly noise; only its errors and critical entries are collected.
        Assert.Equal(new[] { EventLevel.Critical, EventLevel.Error }, EventLogWatch.LevelsFor("Application"));
        // Every log named is one the agent may read.
        var allowed = Catalog.AllowedLogs;
        foreach (string log in EventLogWatch.WarningLogs) Assert.Contains(log, allowed);
    }

    [Fact]
    public async Task Pages_through_a_burst_but_stops_at_a_limit()
    {
        var entries = Enumerable.Range(1, 2000).Select(i => Entry(i, -i % 600)).ToList();
        int calls = 0;
        Task<EventlogQueryOutput> Query(EventlogQueryParams p, CancellationToken _)
        {
            calls++;
            var page = entries.Where(e => p.BeforeRecordId is null || e.RecordId < p.BeforeRecordId).OrderByDescending(e => e.RecordId).Take(p.PageSize!.Value).ToList();
            return Task.FromResult(new EventlogQueryOutput { Log = p.Log, Entries = page, NextBeforeRecordId = page.Count > 0 ? page[^1].RecordId : null, Truncated = true });
        }
        var found = await new EventLogWatch(new StateFile<EventLogWatch.State>(null), Query).CheckAsync("Application", Fixtures.Start, default);
        Assert.Equal(EventLogWatch.MaxPagesPerLook, calls);
        Assert.Equal(EventLogWatch.PageSize * EventLogWatch.MaxPagesPerLook, found.Count);
        Assert.Equal(2000, found[^1].Source!.RecordId);
    }
}

public class MonitorSettingsTests
{
    [Fact]
    public void Console_ids_replace_the_local_fallback_and_survive_a_restart()
    {
        using var dir = new TempDir();
        string file = Path.Combine(dir.Path, "monitor-settings.json");
        var s = new MonitorSettings(file, new[] { "USB\\VID_0001" });
        Assert.Equal(new[] { "USB\\VID_0001" }, s.ScannerHardwareIds);
        int changes = 0;
        s.Changed += () => changes++;
        var answer = new HeartbeatResponse { ServerTime = Fixtures.Start, Scanner = new HeartbeatScanner { HardwareIds = new[] { "USB\\VID_1234&PID_5678" } } };
        s.Apply(answer);
        s.Apply(answer);
        Assert.Equal(1, changes);
        Assert.Equal(new[] { "USB\\VID_1234&PID_5678" }, new MonitorSettings(file).ScannerHardwareIds);
        // The console cleared its IDs: the local fallback applies again.
        s.Apply(answer with { Scanner = new HeartbeatScanner { HardwareIds = null } });
        Assert.Equal(new[] { "USB\\VID_0001" }, new MonitorSettings(file, new[] { "USB\\VID_0001" }).ScannerHardwareIds);
    }

    [Fact]
    public void A_tampered_settings_file_is_ignored()
    {
        using var dir = new TempDir();
        string file = Path.Combine(dir.Path, "monitor-settings.json");
        File.WriteAllText(file, "{\"serverTime\":\"2026-10-06T12:00:00Z\",\"scanner\":{\"hardwareIds\":[\"$(rm -rf /)\"]}}");
        Assert.Null(new MonitorSettings(file).ScannerHardwareIds);
    }
}

public class MonitorHostTests
{
    [Fact]
    public async Task A_forced_scanner_disconnect_reaches_the_queue()
    {
        var devices = new List<DeviceFacts>
        {
            new() { InstanceId = @"USB\VID_1234&PID_5678\1", Name = "Fingerprint Reader", Present = true, ProblemCode = 0, HardwareIds = new[] { @"USB\VID_1234&PID_5678" } },
        };
        var settings = new MonitorSettings(null, new[] { @"USB\VID_1234&PID_5678" });
        var queue = new EventQueue(null);
        var host = new MonitorHost(new MonitorSources { Devices = _ => Task.FromResult<IReadOnlyList<DeviceFacts>>(devices.ToList()) },
            settings, queue, null, new ManualClock(Fixtures.Start), _ => { });
        await host.ScannerOnceAsync(default);
        Assert.Equal(0, queue.Count);
        devices.Clear();
        await host.ScannerOnceAsync(default);
        var e = JsonSerializer.Deserialize<AgentEvent>(Assert.Single(queue.Peek()).Json, ContractJson.Options)!;
        Assert.Equal(EventKind.Scanner, e.Kind);
        Assert.Equal(ScannerState.Disconnected, e.Device!.State);
    }
}
