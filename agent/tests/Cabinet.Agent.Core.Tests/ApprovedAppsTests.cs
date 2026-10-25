using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Services;

namespace Cabinet.Agent.Core.Tests;

/// <summary>Lists built the way the console builds them, for the tests that need a cabinet which has approved something.</summary>
public static class ApprovedLists
{
    public const string Dispenser = @"C:\Program Files\Dispenser\dispenser.exe";

    /// <summary>A list with the fake's scanner service (a service entry) on it.</summary>
    public static ApprovedApps Scanner(string serviceName = "BioScanSvc", string program = Dispenser) =>
        new([Entry(serviceName: serviceName, path: program)]);

    /// <summary>A list with one application entry for a program path.</summary>
    public static ApprovedApps Application(string program, string key = "app:program", string name = "A program") =>
        new([Entry(key: key, kind: ApprovedAppKind.Application, name: name, path: program, serviceName: null)]);

    public static ApprovedAppEntry Entry(string key = "app:scanner", ApprovedAppKind kind = ApprovedAppKind.Service,
        string name = "Biometric scanner", string path = Dispenser, string? serviceName = "BioScanSvc") => new()
    {
        Key = key, Kind = kind, Name = name, Path = path, ServiceName = serviceName,
    };
}

/// <summary>
/// The approved list itself (docs/spec/13-roadmap.md, milestone 10): the programs a start, stop, restart or end may be
/// aimed at. The list is the cabinet's own copy, it is deny-by-default, and every entry is checked against the program on
/// the machine now, so the tests below aim at the ways round that: an empty list, a different program, a lookalike path,
/// and entries the contract would not allow.
/// </summary>
public class ApprovedAppsTests
{
    [Fact]
    public void An_empty_list_approves_nothing()
    {
        ApprovedApps none = ApprovedApps.None;
        Assert.True(none.IsEmpty);
        Assert.Empty(none.Entries);
        Assert.Null(none.ForService("BioScanSvc"));
        Assert.Null(none.ForProgram(ApprovedLists.Dispenser));
        Assert.Equal("execution_failed", Assert.Throws<OperationFailedException>(() => none.RefuseServiceControl("BioScanSvc", ApprovedLists.Dispenser)).Code);
        Assert.Equal("execution_failed", Assert.Throws<OperationFailedException>(() => none.RefuseProcessEnd(4242, "dispenser", ApprovedLists.Dispenser)).Code);
    }

    [Fact]
    public void A_service_entry_approves_that_service_when_it_runs_the_named_program()
    {
        ApprovedApps list = ApprovedLists.Scanner();
        Assert.Equal("app:scanner", Assert.Single(list.Entries).Key);
        // Windows reports paths in its own case; the comparison is exact but ignores case.
        list.RefuseServiceControl("BioScanSvc", ApprovedLists.Dispenser.ToUpperInvariant());
        // A service whose registered path points somewhere else is not the service that was approved.
        Assert.Contains("does not run the program", Assert.Throws<OperationFailedException>(() => list.RefuseServiceControl("BioScanSvc", @"C:\Temp\dispenser.exe")).Message);
        Assert.Contains("does not run the program", Assert.Throws<OperationFailedException>(() => list.RefuseServiceControl("BioScanSvc", null)).Message);
        // The entry names one service; it approves no other.
        Assert.Contains("not on this cabinet's approved list", Assert.Throws<OperationFailedException>(() => list.RefuseServiceControl("PrintSvc", ApprovedLists.Dispenser)).Message);
    }

    [Fact]
    public void An_application_entry_approves_that_exact_program_path_only()
    {
        ApprovedApps list = ApprovedLists.Application(ApprovedLists.Dispenser);
        Assert.NotNull(list.ForProgram(ApprovedLists.Dispenser));
        Assert.NotNull(list.ForProgram(ApprovedLists.Dispenser.ToLowerInvariant()));
        Assert.Null(list.ForProgram(@"C:\Program Files\Dispenser\dispenser64.exe"));
        Assert.Null(list.ForProgram(@"C:\Temp\dispenser.exe"));
        Assert.Null(list.ForProgram(null));
        // An application entry approves no service, even one that runs the same program.
        Assert.Null(list.ForService("BioScanSvc"));
        Assert.Contains("not on this cabinet's approved list", Assert.Throws<OperationFailedException>(() => list.RefuseServiceControl("BioScanSvc", ApprovedLists.Dispenser)).Message);
    }

    [Theory]
    [InlineData("app:", ApprovedAppKind.Service, "A scanner", @"C:\x\a.exe", "BioScanSvc")]                 // key too short
    [InlineData("scanner", ApprovedAppKind.Service, "A scanner", @"C:\x\a.exe", "BioScanSvc")]             // key without its prefix
    [InlineData("app:a/b", ApprovedAppKind.Service, "A scanner", @"C:\x\a.exe", "BioScanSvc")]             // key with a separator
    [InlineData("app:a:b", ApprovedAppKind.Service, "A scanner", @"C:\x\a.exe", "BioScanSvc")]             // key with a colon
    [InlineData("app:ok", ApprovedAppKind.Service, "", @"C:\x\a.exe", "BioScanSvc")]                       // no name
    [InlineData("app:ok", ApprovedAppKind.Service, "two\nlines", @"C:\x\a.exe", "BioScanSvc")]              // control character
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", "dispenser.exe", "BioScanSvc")]             // relative path
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"C:dispenser.exe", "BioScanSvc")]          // no separate folder
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"C:\x\..\a.exe", "BioScanSvc")]            // parent folder
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"\\server\share\a.exe", "BioScanSvc")]     // another machine
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"C:/x/a.exe", "BioScanSvc")]               // forward slashes
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"C:\x\a.bat", "BioScanSvc")]               // not a program file
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"C:\x\a.exe --silent", "BioScanSvc")]      // a command line
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"C:\x\a.exe", null)]                       // service without its key name
    [InlineData("app:ok", ApprovedAppKind.Service, "A scanner", @"C:\x\a.exe", " leading")]                // invalid key name
    [InlineData("app:ok", ApprovedAppKind.Application, "An app", @"C:\x\a.exe", "BioScanSvc")]             // application with a service name
    public void An_entry_the_contract_would_not_allow_is_dropped(string key, ApprovedAppKind kind, string name, string path, string? serviceName)
    {
        var list = new ApprovedApps([new ApprovedAppEntry { Key = key, Kind = kind, Name = name, Path = path, ServiceName = serviceName }]);
        Assert.Empty(list.Entries);
    }

    [Fact]
    public void An_entry_the_contract_allows_is_kept()
    {
        var list = new ApprovedApps([ApprovedLists.Entry(key: "app:ok", kind: ApprovedAppKind.Application, name: "An app", path: @"C:\x\a.exe", serviceName: null)]);
        Assert.Equal(@"C:\x\a.exe", Assert.Single(list.Entries).Program);
    }

    [Fact]
    public void A_kind_the_contract_does_not_have_is_dropped()
    {
        ApprovedAppEntry entry = ApprovedLists.Entry(kind: (ApprovedAppKind)99, serviceName: null);
        Assert.Empty(new ApprovedApps([entry]).Entries);
    }

    [Fact]
    public void The_first_entry_for_a_key_wins_and_no_more_than_the_contract_allows_are_kept()
    {
        ApprovedApps duplicated = new([ApprovedLists.Entry(), ApprovedLists.Entry(path: @"C:\Temp\dispenser.exe")]);
        Assert.Equal(ApprovedLists.Dispenser, Assert.Single(duplicated.Entries).Program);

        var many = Enumerable.Range(0, 40)
            .Select(i => ApprovedLists.Entry(key: $"app:p{i}", kind: ApprovedAppKind.Application, name: $"Program {i}", path: $@"C:\x\p{i}.exe", serviceName: null))
            .ToList();
        Assert.Equal(32, new ApprovedApps(many).Entries.Count);
    }
}

/// <summary>service.control with the approved list in front of it: nothing off the list reaches Windows at all.</summary>
public class ApprovedServiceControlTests
{
    private static ServiceControl Control(FakeServices fake, Func<ApprovedApps> approved) =>
        new(fake, _ => { }) { Approved = approved };

    [Fact]
    public void A_service_off_the_list_is_refused_before_Windows_is_asked()
    {
        var fake = new FakeServices();
        var control = Control(fake, () => ApprovedLists.Application(@"C:\Program Files\Dispenser\dispenser.exe"));
        var e = Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Restart }));
        Assert.Equal("execution_failed", e.Code);
        Assert.Contains("not on this cabinet's approved list", e.Message);
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void A_service_on_the_list_is_controlled()
    {
        var fake = new FakeServices();
        Control(fake, () => ApprovedLists.Scanner()).Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Restart });
        Assert.Equal(["stop BioScanSvc", "start BioScanSvc"], fake.Calls);
    }

    [Fact]
    public void A_service_whose_registered_program_changed_is_refused()
    {
        var fake = new FakeServices();
        fake.Programs["BioScanSvc"] = @"C:\Temp\dispenser.exe";
        var e = Assert.Throws<OperationFailedException>(() =>
            Control(fake, () => ApprovedLists.Scanner()).Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Start }));
        Assert.Contains("does not run the program", e.Message);
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void A_service_whose_program_cannot_be_read_is_refused()
    {
        var fake = new FakeServices();
        fake.Programs.Remove("BioScanSvc");
        var e = Assert.Throws<OperationFailedException>(() =>
            Control(fake, () => ApprovedLists.Scanner()).Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Start }));
        Assert.Contains("does not run the program", e.Message);
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void A_service_the_list_does_not_name_is_refused_even_when_another_one_is_approved()
    {
        var fake = new FakeServices();
        var e = Assert.Throws<OperationFailedException>(() =>
            Control(fake, () => ApprovedLists.Scanner()).Run(new ServiceControlParams { Name = "DisabledSvc", Action = ServiceAction.Stop }));
        Assert.Contains("not on this cabinet's approved list", e.Message);
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void The_list_is_read_again_for_every_request_so_a_changed_list_takes_effect()
    {
        var fake = new FakeServices();
        ApprovedApps current = ApprovedApps.None;
        var control = Control(fake, () => current);
        Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Stop }));
        Assert.Empty(fake.Calls);
        current = ApprovedLists.Scanner();
        control.Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Stop });
        Assert.Equal(["stop BioScanSvc"], fake.Calls);
    }
}

/// <summary>process.end with the approved list in front of it: the program is read from the process, not from the request.</summary>
public class ApprovedProcessEndTests
{
    private static ProcessEndParams Request(string name = "dispenser") => new() { ProcessId = 4242, Name = name };

    /// <summary>One opened process: the program it reports and the end both belong to this one object, as with one handle.</summary>
    private sealed class Opened(string? program) : IOpenedProcess
    {
        public int Ends { get; private set; }
        public int Reads { get; private set; }
        public bool Disposed { get; private set; }
        public string? Program { get { Reads++; return program; } }

        public ProcessEndOutput End(ProcessEndParams p)
        {
            Assert.False(Disposed, "the end must go through the handle the check was made on");
            Ends++;
            return new ProcessEndOutput { ProcessId = p.ProcessId, Name = p.Name, Ended = true };
        }

        public void Dispose() => Disposed = true;
    }

    [Fact]
    public void A_process_on_the_list_is_ended_through_the_handle_its_program_was_read_from()
    {
        var opened = new Opened(ApprovedLists.Dispenser);
        int opens = 0;
        var log = new List<string>();
        ProcessEndOutput output = ApprovedProcessEnd.Run(Request(), ApprovedLists.Application(ApprovedLists.Dispenser), _ => { opens++; return opened; }, log.Add);
        Assert.Equal((1, 1, 1), (opens, opened.Ends, opened.Reads));
        Assert.True(opened.Disposed);
        Assert.Equal(4242, output.ProcessId);
        Assert.Contains(log, line => line.Contains("on the approved list", StringComparison.Ordinal));
    }

    [Fact]
    public void A_process_off_the_list_is_refused_and_never_ended()
    {
        var opened = new Opened(ApprovedLists.Dispenser);
        var e = Assert.Throws<OperationFailedException>(() => ApprovedProcessEnd.Run(Request(), ApprovedApps.None, _ => opened, _ => { }));
        Assert.Equal("execution_failed", e.Code);
        Assert.Contains("not on this cabinet's approved list", e.Message);
        Assert.Equal(0, opened.Ends);
        Assert.True(opened.Disposed, "the handle is closed on a refusal too");
    }

    [Fact]
    public void A_process_whose_program_cannot_be_read_is_refused_and_never_ended()
    {
        var opened = new Opened(null);
        var e = Assert.Throws<OperationFailedException>(() => ApprovedProcessEnd.Run(Request(), ApprovedLists.Application(ApprovedLists.Dispenser), _ => opened, _ => { }));
        Assert.Contains("could not read which program", e.Message);
        Assert.Equal(0, opened.Ends);
    }

    [Fact]
    public void A_process_that_is_gone_is_not_found()
    {
        var e = Assert.Throws<OperationFailedException>(() => ApprovedProcessEnd.Run(Request(), ApprovedLists.Application(ApprovedLists.Dispenser), _ => null, _ => { }));
        Assert.Equal("not_found", e.Code);
    }

    [Fact]
    public void A_process_running_a_lookalike_program_is_refused_even_when_its_name_matches()
    {
        var opened = new Opened(@"C:\Temp\dispenser.exe");
        var e = Assert.Throws<OperationFailedException>(() => ApprovedProcessEnd.Run(Request("dispenser"), ApprovedLists.Application(ApprovedLists.Dispenser), _ => opened, _ => { }));
        Assert.Contains("not on this cabinet's approved list", e.Message);
        Assert.Equal(0, opened.Ends);
    }

    [Fact]
    public async Task The_registered_operation_refuses_an_unapproved_process()
    {
        var opened = new Opened(ApprovedLists.Dispenser);
        OperationRegistry registry = ApprovedProcessEnd.Register(new OperationRegistry(), () => ApprovedApps.None, _ => opened, _ => { });
        Assert.True(registry.TryGet(Catalog.ProcessEnd, out var handler));
        JsonElement parameters = JsonSerializer.SerializeToElement(Request(), ContractJson.Options);
        await Assert.ThrowsAsync<OperationFailedException>(() => handler(parameters, default));
        Assert.Equal(0, opened.Ends);
    }
}

/// <summary>
/// The copy on disk: the network service keeps the heartbeat answer, the broker reads the approved list from it (the
/// broker never touches the network), and a changed list is read again without a restart.
/// </summary>
public class ApprovedAppsOnDiskTests
{
    private static HeartbeatResponse Answer(params ApprovedAppEntry[] entries) => new()
    {
        ServerTime = Fixtures.Start,
        Scanner = new HeartbeatScanner { HardwareIds = ["USB\\VID_1234&PID_5678"] },
        ApprovedApps = new HeartbeatApprovedApps { Entries = entries },
    };

    [Fact]
    public void The_broker_reads_the_list_the_network_service_keeps_and_follows_every_change()
    {
        using var dir = new TempDir();
        var file = Path.Combine(dir.Path, "monitor-settings.json");
        var settings = new MonitorSettings(file);
        var log = new List<string>();
        var broker = new ApprovedAppsFile(file, log.Add);

        // Nothing has been sent yet: nothing is approved.
        Assert.True(broker.Current.IsEmpty);

        // The console approves the scanner. Nothing else in the answer changes, so the file is written for the list alone.
        settings.Apply(Answer(ApprovedLists.Entry()));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(1));
        Assert.Equal("app:scanner", Assert.Single(broker.Current.Entries).Key);

        // The list is taken away: the cabinet controls nothing again, without a broker restart.
        settings.Apply(Answer());
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(2));
        Assert.True(broker.Current.IsEmpty);

        // It is read from a restart of the broker as well.
        settings.Apply(Answer(ApprovedLists.Entry()));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(3));
        Assert.Equal("app:scanner", Assert.Single(new ApprovedAppsFile(file, _ => { }).Current.Entries).Key);
        Assert.Single(new MonitorSettings(file).ApprovedApps);
        Assert.Contains(log, line => line.Contains("Approved list in force: 1 program(s)", StringComparison.Ordinal));
    }

    private static (string File, MonitorSettings Settings, ApprovedAppsFile Broker, List<string> Log) WithGoodList(TempDir dir)
    {
        var file = Path.Combine(dir.Path, "monitor-settings.json");
        var settings = new MonitorSettings(file);
        settings.Apply(Answer(ApprovedLists.Entry()));
        var log = new List<string>();
        var broker = new ApprovedAppsFile(file, log.Add);
        Assert.Single(broker.Current.Entries);
        return (file, settings, broker, log);
    }

    [Fact]
    public void A_good_list_whose_file_disappears_leaves_nothing_approved()
    {
        using var dir = new TempDir();
        var (file, _, broker, log) = WithGoodList(dir);
        File.Delete(file);
        Assert.True(broker.Current.IsEmpty);
        Assert.Contains(log, l => l.Contains("is not there; nothing is approved", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("{\"serverTime\":")]
    [InlineData("")]
    [InlineData("{\"approvedApps\":{\"entries\":[]}}")]
    public void A_good_list_whose_file_is_corrupted_leaves_nothing_approved(string corrupt)
    {
        using var dir = new TempDir();
        var (file, _, broker, _) = WithGoodList(dir);
        File.WriteAllText(file, corrupt);
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(7));
        Assert.True(broker.Current.IsEmpty);
    }

    [Fact]
    public void An_oversized_file_leaves_nothing_approved_and_is_not_read()
    {
        using var dir = new TempDir();
        var (file, _, broker, log) = WithGoodList(dir);
        // 2 GB: reading it would take seconds and the memory to hold it. The size is checked first, so it is never read.
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Write)) stream.SetLength(2L * 1024 * 1024 * 1024);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        Assert.True(broker.Current.IsEmpty);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(2), $"took {clock.Elapsed}");
        Assert.Contains(log, l => l.Contains("it was not read", StringComparison.Ordinal));
    }

    [Fact]
    public void A_file_just_over_the_limit_is_refused_and_one_at_the_limit_is_read()
    {
        using var dir = new TempDir();
        var (file, _, broker, _) = WithGoodList(dir);
        string json = File.ReadAllText(file).TrimEnd();
        File.WriteAllText(file, json + new string(' ', ApprovedAppsFile.MostBytes - System.Text.Encoding.UTF8.GetByteCount(json)));
        Assert.Equal(ApprovedAppsFile.MostBytes, new FileInfo(file).Length);
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(8));
        Assert.Single(broker.Current.Entries);
        File.AppendAllText(file, " ");
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(9));
        Assert.True(broker.Current.IsEmpty);
    }

    [Fact]
    public void A_list_that_breaks_the_contract_is_not_read()
    {
        using var dir = new TempDir();
        var file = Path.Combine(dir.Path, "monitor-settings.json");
        // Valid JSON, but an approved entry with arguments: the contract allows a path only.
        File.WriteAllText(file, """
            {"serverTime":"2026-09-13T00:00:00Z","scanner":{"hardwareIds":null},
             "approvedApps":{"entries":[{"key":"app:scanner","kind":"service","name":"Scanner",
             "path":"C:\\Program Files\\Dispenser\\dispenser.exe","serviceName":"BioScanSvc","arguments":["--silent"]}]}}
            """);
        Assert.True(new ApprovedAppsFile(file, _ => { }).Current.IsEmpty);
    }

    [Fact]
    public void A_file_that_is_not_an_answer_or_not_there_approves_nothing()
    {
        using var dir = new TempDir();
        var file = Path.Combine(dir.Path, "monitor-settings.json");
        Assert.True(new ApprovedAppsFile(file, _ => { }).Current.IsEmpty);
        File.WriteAllText(file, "{\"approvedApps\":{\"entries\":[{\"key\":\"app:scanner\",\"kind\":\"service\",\"name\":\"S\",\"path\":\"C:\\\\x\\\\a.exe\",\"serviceName\":\"BioScanSvc\"}]}}");
        Assert.True(new ApprovedAppsFile(file, _ => { }).Current.IsEmpty);
        File.WriteAllText(file, "not json at all");
        Assert.True(new ApprovedAppsFile(file, _ => { }).Current.IsEmpty);
        Assert.True(new ApprovedAppsFile(null, _ => { }).Current.IsEmpty);
    }

    [Fact]
    public void An_answer_that_carries_no_approved_list_leaves_nothing_approved()
    {
        using var dir = new TempDir();
        var file = Path.Combine(dir.Path, "monitor-settings.json");
        var settings = new MonitorSettings(file);
        settings.Apply(Answer(ApprovedLists.Entry()));
        Assert.Single(new MonitorSettings(file).ApprovedApps);
        var broker = new ApprovedAppsFile(file, _ => { });
        Assert.Single(broker.Current.Entries);

        // An older server's answer carries no approved list at all: the contract says the agent keeps an empty one, so
        // the list on disk is emptied too and the broker stops acting on it.
        settings.Apply(new HeartbeatResponse { ServerTime = Fixtures.Start, Scanner = new HeartbeatScanner { HardwareIds = null } });
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(5));
        Assert.Empty(new MonitorSettings(file).ApprovedApps);
        Assert.True(broker.Current.IsEmpty);
    }
}
