using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Services;

namespace Cabinet.Agent.Core.Tests;

/// <summary>A service manager in memory: services can be stopped by the test, and made to refuse starting.</summary>
public sealed class FakeServices : IServicePlatform
{
    public Dictionary<string, (ServiceState State, ServiceStartType Start)> Services { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["BioScanSvc"] = (ServiceState.Running, ServiceStartType.Automatic),
        ["DisabledSvc"] = (ServiceState.Stopped, ServiceStartType.Disabled),
        ["TermService"] = (ServiceState.Stopped, ServiceStartType.Manual),
        ["CabinetAgentNetwork"] = (ServiceState.Running, ServiceStartType.Automatic),
    };
    public HashSet<string> WillNotStart { get; } = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>The program each service's registered path points at, as Windows reports it; null for a service it will not say.</summary>
    public Dictionary<string, string?> Programs { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["BioScanSvc"] = ApprovedLists.Dispenser,
    };
    public List<string> Calls { get; } = [];

    public IReadOnlyList<ServiceInfo> List() => Services.Select(s => new ServiceInfo
    {
        Name = s.Key, DisplayName = s.Key, State = s.Value.State, StartType = s.Value.Start, Account = null, ProcessId = null, ExecutablePath = Programs.GetValueOrDefault(s.Key), Description = null, Recovery = null,
    }).ToList();

    public (ServiceState State, ServiceStartType StartType)? Query(string name) => Services.TryGetValue(name, out var s) ? s : null;

    /// <summary>Display names, as Windows' service manager would also accept them.</summary>
    public Dictionary<string, string> DisplayNames { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Remote Desktop Services"] = "TermService", ["Mashura Cabinet Agent Network"] = "CabinetAgentNetwork", ["Biometric Scanner Service"] = "BioScanSvc",
    };

    public string? KeyName(string name) => Services.Keys.FirstOrDefault(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase));

    public void SetStartType(string name, ServiceStartType startType)
    {
        Calls.Add($"starttype {name} {startType}");
        Services[name] = Services[name] with { Start = startType };
    }

    public void Start(string name)
    {
        Calls.Add("start " + name);
        if (WillNotStart.Contains(name)) throw new ServiceControlException(1053, "no");
        Services[name] = Services[name] with { State = ServiceState.Running };
    }

    public void Stop(string name)
    {
        Calls.Add("stop " + name);
        Services[name] = Services[name] with { State = ServiceState.Stopped };
    }
}

public class ServiceRuleTests
{
    [Theory]
    [InlineData("BioScanSvc", true)]
    [InlineData("MSSQL$SQLEXPRESS", true)]
    [InlineData("Some Service", true)]
    [InlineData(" leading", false)]
    [InlineData("trailing ", false)]
    [InlineData("..\\..\\x", false)]
    [InlineData("a & net user x", false)]
    [InlineData("a;b", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Service_names_follow_the_contract(string? name, bool valid) => Assert.Equal(valid, ServiceRules.IsValidName(name));

    [Fact]
    public void Service_names_over_80_characters_are_refused() => Assert.False(ServiceRules.IsValidName(new string('a', 81)));

    [Fact]
    public void The_agent_never_touches_its_own_or_remote_access_services()
    {
        var fake = new FakeServices();
        var control = new ServiceControl(fake, _ => { });
        foreach (string name in new[] { "CabinetAgentNetwork", "cabinetagentbroker", "TermService", "WinRM", "RemoteRegistry" })
            Assert.Contains("never", Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = name, Action = ServiceAction.Restart })).Message);
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void A_disabled_service_is_not_started_and_an_unknown_one_is_not_found()
    {
        var fake = new FakeServices();
        var control = new ServiceControl(fake, _ => { });
        Assert.Contains("disabled", Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = "DisabledSvc", Action = ServiceAction.Start })).Message);
        Assert.Equal("not_found", Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = "NoSuchSvc", Action = ServiceAction.Start })).Code);
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public void Restart_stops_then_starts_and_reports_before_and_after()
    {
        var fake = new FakeServices();
        var control = new ServiceControl(fake, _ => { }) { Approved = () => ApprovedLists.Scanner() };
        var output = control.Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Restart });
        Assert.Equal(["stop BioScanSvc", "start BioScanSvc"], fake.Calls);
        Assert.Equal((ServiceState.Running, ServiceState.Running), (output.Before, output.After));
    }

    [Fact]
    public void A_start_Windows_refuses_fails_with_its_error_code()
    {
        var fake = new FakeServices();
        fake.Services["BioScanSvc"] = (ServiceState.Stopped, ServiceStartType.Automatic);
        fake.WillNotStart.Add("BioScanSvc");
        var control = new ServiceControl(fake, _ => { }) { Approved = () => ApprovedLists.Scanner() };
        var e = Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = "BioScanSvc", Action = ServiceAction.Start }));
        Assert.Equal("execution_failed", e.Code);
        Assert.Contains("1053", e.Message);
    }
}

public class ServiceWatcherTests
{
    private readonly ManualClock _clock = new(Fixtures.Start);
    private readonly FakeServices _fake = new();
    private readonly List<string> _log = [];
    private ServiceWatcher Watcher(StateFile<ServiceWatcher.Saved>? store = null) => new(_fake, store ?? new StateFile<ServiceWatcher.Saved>(null), _clock, _log.Add);
    private static WatchedServiceStatus Of(ServiceWatcher w, string name) => w.Status().Single(s => s.Name == name);

    [Fact]
    public void A_watched_service_that_stops_is_started_again_and_counted()
    {
        var w = Watcher();
        w.SetList(["BioScanSvc"]);
        w.Tick();
        Assert.Equal(WatchState.Running, Of(w, "BioScanSvc").State);
        _fake.Services["BioScanSvc"] = (ServiceState.Stopped, ServiceStartType.Automatic);
        _clock.Advance(TimeSpan.FromSeconds(30));
        w.Tick();
        var s = Of(w, "BioScanSvc");
        Assert.Equal((WatchState.Restarted, 1L, ServiceState.Running), (s.State, s.RestartsToday, _fake.Services["BioScanSvc"].State));
        _clock.Advance(TimeSpan.FromMinutes(11));
        w.Tick();
        Assert.Equal(WatchState.Running, Of(w, "BioScanSvc").State);
    }

    [Fact]
    public void Three_failed_restarts_in_a_row_mean_failing_then_a_wait_of_15_minutes_before_trying_again()
    {
        var w = Watcher();
        w.SetList(["BioScanSvc"]);
        _fake.Services["BioScanSvc"] = (ServiceState.Stopped, ServiceStartType.Automatic);
        _fake.WillNotStart.Add("BioScanSvc");
        for (int i = 0; i < 3; i++) { w.Tick(); _clock.Advance(TimeSpan.FromSeconds(30)); }
        var s = Of(w, "BioScanSvc");
        Assert.Equal((WatchState.Failing, 3L, 1053L), (s.State, s.ConsecutiveFailures, s.LastError!.Value));
        int tries = _fake.Calls.Count;
        for (int i = 0; i < 10; i++) { w.Tick(); _clock.Advance(TimeSpan.FromSeconds(30)); } // 5 minutes: no more tries
        Assert.Equal(tries, _fake.Calls.Count);
        _clock.Advance(TimeSpan.FromMinutes(11));
        _fake.WillNotStart.Clear();
        w.Tick();
        Assert.Equal(tries + 1, _fake.Calls.Count);
        Assert.Equal(ServiceState.Running, _fake.Services["BioScanSvc"].State);
        Assert.Equal(WatchState.Failing, Of(w, "BioScanSvc").State); // still failing until it holds for 10 minutes
        _clock.Advance(TimeSpan.FromMinutes(10));
        w.Tick();
        Assert.Equal((WatchState.Running, 0L), (Of(w, "BioScanSvc").State, Of(w, "BioScanSvc").ConsecutiveFailures)); // held for 10 minutes: healthy again
    }

    [Fact]
    public void A_service_that_stops_again_within_two_minutes_of_its_restart_counts_as_a_failed_restart()
    {
        var w = Watcher();
        w.SetList(["BioScanSvc"]);
        for (int i = 0; i < 3; i++)
        {
            _fake.Services["BioScanSvc"] = (ServiceState.Stopped, ServiceStartType.Automatic);
            w.Tick(); // started again
            _clock.Advance(TimeSpan.FromSeconds(30));
        }
        _fake.Services["BioScanSvc"] = (ServiceState.Stopped, ServiceStartType.Automatic);
        w.Tick();
        Assert.Equal(WatchState.Failing, Of(w, "BioScanSvc").State);
    }

    [Fact]
    public void Missing_disabled_and_refused_services_are_reported_and_never_started()
    {
        var w = Watcher();
        w.SetList(["NoSuchSvc", "DisabledSvc", "TermService", "CabinetAgentNetwork"]);
        w.Tick();
        Assert.Equal([WatchState.Missing, WatchState.Disabled, WatchState.Refused, WatchState.Refused], w.Status().Select(s => s.State));
        Assert.Empty(_fake.Calls);
    }

    [Fact]
    public void The_list_is_checked_again_capped_and_the_state_survives_a_broker_restart()
    {
        using var dir = new TempDir();
        var store = new StateFile<ServiceWatcher.Saved>(dir.File("watch.json"));
        var w = Watcher(store);
        w.SetList([.. Enumerable.Range(0, 20).Select(i => $"Svc{i}"), "bad;name", "BioScanSvc"]);
        Assert.Equal(16, w.Status().Count);
        Assert.DoesNotContain(w.Status(), s => s.Name == "bad;name");
        w.SetList(["BioScanSvc"]);
        _fake.Services["BioScanSvc"] = (ServiceState.Stopped, ServiceStartType.Automatic);
        w.Tick();
        var restarted = Watcher(store);
        Assert.Equal(1, Of(restarted, "BioScanSvc").RestartsToday);
    }

    [Fact]
    public void Restarts_today_start_again_at_midnight_UTC()
    {
        var w = Watcher();
        w.SetList(["BioScanSvc"]);
        _fake.Services["BioScanSvc"] = (ServiceState.Stopped, ServiceStartType.Automatic);
        w.Tick();
        Assert.Equal(1, Of(w, "BioScanSvc").RestartsToday);
        _clock.Advance(TimeSpan.FromHours(13));
        w.Tick();
        Assert.Equal(0, Of(w, "BioScanSvc").RestartsToday);
    }
}

public class ServiceWatchReporterTests
{
    private readonly ManualClock _clock = new(Fixtures.Start);
    private static WatchedServiceStatus S(WatchState state, DateTimeOffset? restartedAt = null, long failures = 0) => new()
    {
        Name = "BioScanSvc", State = state, ServiceState = ServiceState.Running, RestartsToday = restartedAt is null ? 0 : 1, ConsecutiveFailures = failures,
        LastRestartAt = restartedAt, LastError = failures > 0 ? 1053 : null, CheckedAt = Fixtures.Start,
    };

    [Fact]
    public void Each_change_is_reported_once_with_the_right_severity()
    {
        var store = new StateFile<ServiceWatchReporter.Seen>(null);
        var r = new ServiceWatchReporter(store, _clock);
        Assert.Empty(r.Observe([S(WatchState.Running)]));
        var restarted = r.Observe([S(WatchState.Restarted, Fixtures.Start)]);
        Assert.Equal(("restarted", SeverityHint.Minor), (restarted.Single().Detail!.Fields!["change"], restarted.Single().SeverityHint));
        Assert.Empty(r.Observe([S(WatchState.Restarted, Fixtures.Start)]));
        var failing = r.Observe([S(WatchState.Failing, Fixtures.Start, 3)]);
        Assert.Equal(("failing", SeverityHint.Major, "1053"), (failing.Single().Detail!.Fields!["change"], failing.Single().SeverityHint, failing.Single().Detail!.Fields!["errorCode"]));
        Assert.Empty(r.Observe([S(WatchState.Failing, Fixtures.Start, 3)]));
        Assert.Equal("recovered", r.Observe([S(WatchState.Restarted, Fixtures.Start.AddMinutes(20))]).Single().Detail!.Fields!["change"]);
        // A new reporter over the same memory reports nothing again (a network service restart).
        Assert.Empty(new ServiceWatchReporter(store, _clock).Observe([S(WatchState.Restarted, Fixtures.Start.AddMinutes(20))]));
    }

    [Fact]
    public void Missing_and_disabled_are_reported_and_every_event_matches_the_contract()
    {
        var r = new ServiceWatchReporter(new StateFile<ServiceWatchReporter.Seen>(null), _clock);
        var events = r.Observe([S(WatchState.Missing) with { Name = "NoSuchSvc", ServiceState = null }, S(WatchState.Disabled) with { Name = "DisabledSvc" }]);
        Assert.Equal(["missing", "disabled"], events.Select(e => e.Detail!.Fields!["change"]));
        foreach (var e in events)
            Assert.True(ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("event"), JsonSerializer.SerializeToElement(e, ContractJson.Options)));
    }
}

public class ServiceDisplayNameTests
{
    [Theory]
    [InlineData("Remote Desktop Services")]        // TermService's display name
    [InlineData("Mashura Cabinet Agent Network")]  // the agent's own service
    [InlineData("Biometric Scanner Service")]      // even an allowed service: key names only
    public void A_display_name_never_reaches_a_service(string name)
    {
        var platform = new FakeServices();
        var control = new ServiceControl(platform, _ => { });
        var e = Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = name, Action = ServiceAction.Start }));
        Assert.Equal("not_found", e.Code);
        Assert.Empty(platform.Calls);
    }

    [Fact]
    public void The_refused_list_holds_whatever_case_the_key_name_is_written_in()
    {
        var platform = new FakeServices();
        var control = new ServiceControl(platform, _ => { });
        foreach (string name in new[] { "termservice", "TERMSERVICE", "cabinetagentnetwork" })
            Assert.Throws<OperationFailedException>(() => control.Run(new ServiceControlParams { Name = name, Action = ServiceAction.Start }));
        Assert.Empty(platform.Calls);
    }
}

public class ServiceStartTypeTests
{
    private static (ServiceControl Control, FakeServices Fake) Make() { var f = new FakeServices(); return (new ServiceControl(f, _ => { }), f); }
    private static ServiceSetStartTypeParams P(string name, ServiceStartType t) => new() { Name = name, StartType = t };

    [Fact]
    public void A_disabled_service_can_be_set_to_manual_and_the_change_is_read_back()
    {
        var (c, f) = Make();
        var o = c.SetStartType(P("DisabledSvc", ServiceStartType.Manual));
        Assert.Equal((ServiceStartType.Disabled, ServiceStartType.Manual), (o.Before, o.After));
        Assert.Contains("starttype DisabledSvc Manual", f.Calls);
    }

    [Fact]
    public void An_unchanged_start_type_changes_nothing()
    {
        var (c, f) = Make();
        c.SetStartType(P("BioScanSvc", ServiceStartType.Automatic));
        Assert.Empty(f.Calls);
    }

    [Theory]
    [InlineData("TermService")]
    [InlineData("CabinetAgentNetwork")]
    [InlineData("Remote Desktop Services")]
    public void Refused_services_and_display_names_are_never_touched(string name)
    {
        var (c, f) = Make();
        Assert.Throws<OperationFailedException>(() => c.SetStartType(P(name, ServiceStartType.Disabled)));
        Assert.Empty(f.Calls);
    }

    [Theory]
    [InlineData(ServiceStartType.Boot)]
    [InlineData(ServiceStartType.System)]
    [InlineData(ServiceStartType.Unknown)]
    public void Only_four_start_types_can_be_set(ServiceStartType t)
    {
        var (c, f) = Make();
        Assert.Throws<OperationFailedException>(() => c.SetStartType(P("BioScanSvc", t)));
        Assert.Empty(f.Calls);
    }

    [Fact]
    public void A_driver_start_type_is_never_changed()
    {
        var (c, f) = Make();
        f.Services["disk"] = (ServiceState.Running, ServiceStartType.Boot);
        Assert.Throws<OperationFailedException>(() => c.SetStartType(P("disk", ServiceStartType.Disabled)));
        Assert.Empty(f.Calls);
    }

    [Theory]
    [InlineData("")]
    [InlineData("..\\evil")]
    [InlineData("a;b")]
    [InlineData("name with \"quote")]
    public void Hostile_names_are_refused_before_any_lookup(string name)
    {
        var (c, f) = Make();
        Assert.Throws<OperationFailedException>(() => c.SetStartType(P(name, ServiceStartType.Manual)));
        Assert.Empty(f.Calls);
    }
}
