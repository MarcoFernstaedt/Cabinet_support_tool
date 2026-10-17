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

    internal static bool Valid(AgentEvent e)
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

    private static DeviceFacts Biometric(string id, bool present) => new()
    {
        InstanceId = $@"USB\{id}\0001", Name = "Fingerprint Reader " + id, Class = "Biometric", Present = present, ProblemCode = 0,
        HardwareIds = new[] { $@"USB\{id}" },
    };

    [Fact]
    public void With_no_ids_set_it_follows_the_biometric_device_so_a_swapped_scanner_keeps_working()
    {
        var w = new ScannerWatch();
        Assert.Null(w.Observe(null, new[] { Mouse() }, Fixtures.Start)); // nothing biometric ever seen: quiet
        Assert.Null(w.Observe(null, new[] { Biometric("VID_1234&PID_5678", true), Mouse() }, Fixtures.Start));
        // The old scanner unplugged and a different model plugged in: Windows remembers the old one, but the connected one is watched.
        Assert.Null(w.Observe(null, new[] { Biometric("VID_1234&PID_5678", false), Biometric("VID_ABCD&PID_0001", true) }, Fixtures.Start));
        // Only the remembered one left: disconnected.
        var gone = w.Observe(null, new[] { Biometric("VID_ABCD&PID_0001", false), Mouse() }, Fixtures.Start);
        Assert.Equal(ScannerState.Disconnected, gone!.Device!.State);
        Assert.Equal(@"USB\VID_ABCD&PID_0001", gone.Device.HardwareIds[0]);
    }

    [Fact]
    public void A_vendor_id_from_the_console_covers_a_new_model()
    {
        var w = new ScannerWatch();
        string[] vendor = { @"USB\VID_1234" };
        Assert.Null(w.Observe(vendor, new[] { Scanner() }, Fixtures.Start));
        Assert.Null(w.Observe(vendor, new[] { Biometric("VID_1234&PID_9999", true) }, Fixtures.Start));
        Assert.NotNull(w.Observe(vendor, new[] { Biometric("VID_ABCD&PID_0001", true) }, Fixtures.Start)); // another vendor is not the scanner
    }

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
    public async Task The_first_look_reads_crash_storage_and_hardware_evidence_from_30_days_back_and_nothing_else_that_far()
    {
        EventSummary At(long id, double days, string source, int eventId) => new()
            { RecordId = id, Time = Fixtures.Start.AddDays(-days), Level = EventLevel.Error, Source = source, EventId = eventId, FirstLine = "x" };
        var entries = new List<EventSummary>
        {
            At(1, 40, "BugCheck", 1001),                       // too old even for evidence
            At(2, 20, "BugCheck", 1001),                       // a blue screen 20 days before the install
            At(3, 12, "disk", 7),                              // a bad block
            At(4, 9, "Microsoft-Windows-WHEA-Logger", 18),     // a hardware error
            At(5, 10, "Service Control Manager", 7031),        // an ordinary error: only the normal 24 hours
            At(6, 0.5, "Service Control Manager", 7031),       // within the normal first look
        };
        var asked = new List<EventlogQueryParams>();
        Task<EventlogQueryOutput> Query(EventlogQueryParams p, CancellationToken _)
        {
            asked.Add(p);
            var page = entries.Where(e => (p.From is null || e.Time >= p.From) && (p.To is null || e.Time <= p.To)
                    && (p.Source is null || e.Source == p.Source) && (p.EventIds is null || p.EventIds.Contains(e.EventId)))
                .OrderByDescending(e => e.RecordId).Take(p.PageSize ?? 100).ToList();
            return Task.FromResult(new EventlogQueryOutput { Log = p.Log, Entries = page, NextBeforeRecordId = null, Truncated = false });
        }
        using var dir = new TempDir();
        var store = new StateFile<EventLogWatch.State>(Path.Combine(dir.Path, "b.json"));
        var found = await new EventLogWatch(store, Query).CheckAsync("System", Fixtures.Start, default);
        Assert.Equal(new long[] { 2, 3, 4, 6 }, found.Select(e => e.Source!.RecordId));
        Assert.All(asked.Where(q => q.Source is not null), q => Assert.Equal(Fixtures.Start - EventLogWatch.EvidenceLookBack, q.From));
        // The next look starts from now, not from the oldest evidence; and only the System log reads evidence.
        asked.Clear();
        Assert.Empty(await new EventLogWatch(store, Query).CheckAsync("System", Fixtures.Start.AddMinutes(1), default));
        Assert.Single(asked);
        Assert.True(asked[0].From >= Fixtures.Start.AddMinutes(-5));
        asked.Clear();
        await new EventLogWatch(store, Query).CheckAsync("Application", Fixtures.Start, default);
        Assert.DoesNotContain(asked, q => q.Source is not null);
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
        // 500 entries read, all from one source: 20 sent, one summary for the other 480, and one saying the look overflowed.
        Assert.Equal(EventLogWatch.MaxPerSourcePerLook, found.Count(e => e.Kind == EventKind.Error));
        Assert.Contains(found, e => e.Kind == EventKind.AgentStatus && e.Detail!.Fields!.GetValueOrDefault("skipped") == "480");
        Assert.Contains(found, e => e.Kind == EventKind.AgentStatus && e.Detail!.Fields!.GetValueOrDefault("overflow") == "true");
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

public class DriveSnapshotTests
{
    private static DriveSmart Drive(string serial, int? wear = 5) => new() { Model = "SSD", SerialNumber = serial, Health = DriveHealth.Healthy, PredictFailure = false, TemperatureCelsius = 38,
        PowerOnHours = 1000, ReallocatedSectors = 0, PendingSectors = 0, UncorrectableErrors = 0, WearPercent = wear };

    [Fact]
    public async Task The_drive_report_is_kept_for_one_heartbeat_even_when_nothing_is_wrong_and_is_not_sent_twice()
    {
        var drives = new List<DriveSmart> { Drive("A1"), Drive("B2") };
        var queue = new EventQueue(null);
        var host = new MonitorHost(new MonitorSources { Drives = _ => Task.FromResult(new DiskSmartOutput { Drives = drives }) }, new MonitorSettings(null, null), queue, null, new ManualClock(Fixtures.Start), _ => { });
        Assert.Null(host.PeekDriveSnapshot());
        await host.DrivesOnceAsync(new DriveWatch(new StateFile<DriveWatch.State>(null)), default);
        Assert.Equal(0, queue.Count);                       // healthy drives raise no event ...
        var report = host.PeekDriveSnapshot()!;
        Assert.Equal(["A1", "B2"], report.Select(d => d.SerialNumber));   // ... but are reported
        Assert.Equal(["A1", "B2"], host.PeekDriveSnapshot()!.Select(d => d.SerialNumber));   // and kept when the heartbeat fails
        host.DrivesSent(report);
        Assert.Null(host.PeekDriveSnapshot());              // sent once the server accepted it
        await host.DrivesOnceAsync(new DriveWatch(new StateFile<DriveWatch.State>(null)), default);
        var newer = host.PeekDriveSnapshot()!;
        host.DrivesSent(report);                            // the old report being acknowledged does not drop a newer one
        Assert.Same(newer, host.PeekDriveSnapshot());
    }

    [Fact]
    public async Task A_failing_drive_still_raises_its_warning_and_is_in_the_report()
    {
        var bad = Drive("C3") with { Health = DriveHealth.Failing, PredictFailure = true };
        var queue = new EventQueue(null);
        var host = new MonitorHost(new MonitorSources { Drives = _ => Task.FromResult(new DiskSmartOutput { Drives = [bad] }) }, new MonitorSettings(null, null), queue, null, new ManualClock(Fixtures.Start), _ => { });
        await host.DrivesOnceAsync(new DriveWatch(new StateFile<DriveWatch.State>(null)), default);
        Assert.Equal(1, queue.Count);
        Assert.Single(host.PeekDriveSnapshot()!);
    }
}

public class ChangeWatchTests
{
    private static EventSummary Entry(long id, int minutes, string source, int eventId, EventLevel level = EventLevel.Information, string line = "Change.") => new()
    {
        RecordId = id, Time = Fixtures.Start.AddMinutes(minutes), Level = level, Source = source, EventId = eventId, FirstLine = line,
    };

    [Fact]
    public async Task Reports_only_the_listed_changes_once_and_leaves_errors_to_the_error_watcher()
    {
        var entries = new List<EventSummary>
        {
            Entry(10, -600, "Microsoft-Windows-WindowsUpdateClient", 19, line: "Installation Successful: Windows successfully installed the following update: KB5050011"),
            Entry(11, -590, "microsoft-windows-userpnp", 20001, line: "Driver Management concluded the process to install driver iastorac.inf"),
            Entry(12, -580, "Some-Other-Source", 19),                           // same ID, not the listed source
            Entry(13, -570, "Microsoft-Windows-WindowsUpdateClient", 19, EventLevel.Error), // an error: the error watcher reports it
            Entry(14, -560, "Microsoft-Windows-Kernel-General", 12, line: "The operating system started at system time 2026-10-08T03:12:00Z."),
        };
        var asked = new List<EventlogQueryParams>();
        Task<EventlogQueryOutput> Query(EventlogQueryParams p, CancellationToken _)
        {
            asked.Add(p);
            var page = entries.Where(e => p.EventIds!.Contains(e.EventId) && (p.BeforeRecordId is null || e.RecordId < p.BeforeRecordId)).OrderByDescending(e => e.RecordId).ToList();
            return Task.FromResult(new EventlogQueryOutput { Log = p.Log, Entries = page, NextBeforeRecordId = null, Truncated = false });
        }
        using var dir = new TempDir();
        var store = new StateFile<EventLogWatch.State>(Path.Combine(dir.Path, "c.json"));
        var first = await new ChangeWatch(store, Query).CheckAsync("System", Fixtures.Start, default);
        Assert.Equal(new long[] { 10, 11, 14 }, first.Select(e => e.Source!.RecordId));
        Assert.All(first, e => Assert.Equal(EventKind.Change, e.Kind));
        Assert.Equal(Fixtures.Start - ChangeWatch.FirstLookBack, asked[0].From);
        Assert.Null(asked[0].Levels);
        Assert.True(asked[0].EventIds!.Count <= 20, "the query contract allows at most 20 event IDs");
        Assert.Empty(await new ChangeWatch(store, Query).CheckAsync("System", Fixtures.Start.AddMinutes(1), default));
        entries.Add(Entry(20, 2, "User32", 1074, line: "The process C:\\Windows\\system32\\wuauclt.exe has initiated the restart of computer CAB-01."));
        Assert.Equal(new long[] { 20 }, (await new ChangeWatch(store, Query).CheckAsync("System", Fixtures.Start.AddMinutes(3), default)).Select(e => e.Source!.RecordId));
        // A log with nothing listed is not read at all.
        Assert.Empty(await new ChangeWatch(store, Query).CheckAsync("Security", Fixtures.Start, default));
        Assert.DoesNotContain(asked, p => p.Log == "Security");
    }

    [Fact]
    public void Every_change_event_passes_the_event_contract_and_every_listed_log_is_readable()
    {
        foreach (var w in ChangeWatch.List)
        {
            Assert.Contains(w.Log, Catalog.AllowedLogs);
            var e = ChangeWatch.ToEvent(w.Log, Entry(1, 0, w.Source, w.EventId, line: "A change."));
            Assert.True(EventQueueTests.Valid(e), $"{w.Source} {w.EventId}");
        }
        Assert.True(ChangeWatch.List.GroupBy(w => w.Log).All(g => g.Select(w => w.EventId).Distinct().Count() <= 20));
    }
}

public class EventFloodTests
{
    [Fact]
    public async Task A_flooded_log_sends_at_most_20_entries_per_source_and_a_summary_and_real_errors_still_get_through()
    {
        var entries = Enumerable.Range(1, 300).Select(i => new EventSummary
        {
            RecordId = i, Time = Fixtures.Start.AddSeconds(-600 + i), Level = EventLevel.Error, Source = "Spammer", EventId = 1, FirstLine = "flood",
        }).ToList();
        entries.Add(new EventSummary { RecordId = 301, Time = Fixtures.Start, Level = EventLevel.Critical, Source = "Microsoft-Windows-Kernel-Power", EventId = 41, FirstLine = "real" });
        Task<EventlogQueryOutput> Query(EventlogQueryParams p, CancellationToken _)
        {
            var page = entries.Where(e => p.BeforeRecordId is null || e.RecordId < p.BeforeRecordId).OrderByDescending(e => e.RecordId).Take(p.PageSize!.Value).ToList();
            return Task.FromResult(new EventlogQueryOutput { Log = p.Log, Entries = page, NextBeforeRecordId = page.Count > 0 ? page[^1].RecordId : null, Truncated = false });
        }
        using var dir = new TempDir();
        var events = await new EventLogWatch(new StateFile<EventLogWatch.State>(Path.Combine(dir.Path, "b.json")), Query).CheckAsync("Application", Fixtures.Start, default);
        Assert.Equal(20, events.Count(e => e.Source?.Source == "Spammer"));
        Assert.Single(events, e => e.Source?.EventId == 41);
        var summary = Assert.Single(events, e => e.Kind == EventKind.AgentStatus);
        Assert.Equal("280", summary.Detail!.Fields!["skipped"]);
        foreach (var e in events) Assert.True(EventQueueTests.Valid(e));
    }
}
