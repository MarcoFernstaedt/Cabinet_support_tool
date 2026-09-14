using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// The Machine tab rendering real check-in data fetched from the real server.
/// </summary>
public sealed class MachineTabTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;

    public MachineTabTests(ConsoleTestHost host) => _host = host;

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];

    private async Task<(MachineTabViewModel Tab, Cabinet Cabinet, RecordingLiveRegionAnnouncer Announcer,
        ScriptedActionDialog Dialog)>
        SignedInTabAsync(Role role, ScriptedActionDialog? dialog = null)
    {
        string username = Unique("m");
        await _host.CreateUserAsync(role, username);

        (ApiClient api, SessionStore session) = _host.CreateConsole();

        await api.LoginAsync(
            new Contracts.Auth.LoginRequest
            {
                Username = username,
                Password = ConsoleTestHost.KnownPassword
            },
            CancellationToken.None);

        RecordingLiveRegionAnnouncer announcer = new();
        dialog ??= ScriptedActionDialog.Accepting();

        var tab = new MachineTabViewModel(
            api,
            new ActionInvoker(api, dialog, announcer, session),
            session,
            announcer,
            TimeProvider.System);

        Cabinet cabinet = await _host.CreateCabinetAsync($"CUBEX-{Unique("h")[..8]}");

        return (tab, cabinet, announcer, dialog);
    }

    [Fact]
    public async Task Scalar_bindings_are_notified_on_load_and_cleared_when_data_is_unavailable()
    {
        var (tab, cabinet, _, _) = await SignedInTabAsync(Role.Tier2);
        await _host.AddFullCheckInAsync(cabinet.Id, TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow), DateTimeOffset.UtcNow);
        var network = new List<string?>();
        var system = new List<string?>();
        tab.Network.PropertyChanged += (_, e) => network.Add(e.PropertyName);
        tab.System.PropertyChanged += (_, e) => system.Add(e.PropertyName);
        await tab.LoadAsync(cabinet.Id);
        Assert.Contains(nameof(tab.System.OsVersion), system);
        Assert.Contains(nameof(tab.Network.Proxy), network);
        await tab.LoadAsync(Guid.NewGuid());
        Assert.Equal(Format.NotReported, tab.System.OsVersion);
        Assert.Equal(Format.NotReported, tab.System.Domain);
        Assert.Equal(Format.NotReported, tab.System.TimeZone);
    }

    [Fact]
    public async Task Reboot_indicator_uses_heartbeat_not_security_classification()
    {
        var (tab, cabinet, _, _) = await SignedInTabAsync(Role.Tier2);
        var payload = TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow);
        payload = payload with { WindowsUpdate = payload.WindowsUpdate! with { RebootPending = false } };
        await _host.AddFullCheckInAsync(cabinet.Id, payload, DateTimeOffset.UtcNow);
        await tab.LoadAsync(cabinet.Id);
        Assert.Equal("No reboot pending", tab.WindowsUpdate.RebootPending.Label);
        Assert.Contains("security", tab.WindowsUpdate.SecurityPending.Label);
    }

    [Fact]
    public async Task Refresh_recovers_completed_process_results_from_action_history()
    {
        var (tab, cabinet, _, _) = await SignedInTabAsync(Role.Tier2);
        await _host.AddFullCheckInAsync(cabinet.Id, TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow), DateTimeOffset.UtcNow);
        await tab.LoadAsync(cabinet.Id);
        await tab.Processes.Actions.Single(a => a.Catalogue.Action == ActionName.GetProcessList).InvokeCommand.ExecuteAsync(null);
        await _host.WithDbAsync(async db =>
        {
            var action = db.ActionRequests.Single(a => a.CabinetId == cabinet.Id);
            action.Status = ActionRequestStatus.Completed;
            action.ResultStatus = ActionStatus.Succeeded;
            action.CompletedUtc = DateTimeOffset.UtcNow;
            action.ResultOutput = "Process snapshot collected";
            action.CollectedDataJson = "[{\"pid\":123,\"name\":\"test.exe\"}]";
            return await db.SaveChangesAsync();
        });
        await tab.RefreshCommand.ExecuteAsync(null);
        Assert.Single(tab.Processes.Processes);
        Assert.Equal("Process snapshot collected", Assert.Single(tab.ActionHistory).ResultOutput);
        tab.Processes.SelectedProcess = tab.Processes.Processes.Single();
        tab.Processes.SelectedProcess = null;
        Assert.True(tab.Processes.Actions.Single(a => a.Catalogue.Action == ActionName.GetProcessList).InvokeCommand.CanExecute(null));
    }

    [Fact]
    public async Task Loading_another_cabinet_clears_identity_and_disables_actions_immediately()
    {
        var (tab, cabinet, _, _) = await SignedInTabAsync(Role.Tier2);
        await tab.LoadAsync(cabinet.Id);
        var load = tab.LoadAsync(Guid.NewGuid());
        Assert.Null(tab.Path);
        Assert.Empty(tab.CabinetHostname);
        Assert.All(tab.Sections.SelectMany(s => s.Actions), a => Assert.False(a.InvokeCommand.CanExecute(null)));
        await load;
        Assert.Null(tab.Path);
        Assert.Equal(Format.NotReported, tab.Overview.Hostname);
        Assert.All(tab.Sections.SelectMany(s => s.Actions), a => Assert.False(a.InvokeCommand.CanExecute(null)));
    }

    [Fact]
    public async Task A_cabinet_with_a_check_in_renders_real_data_in_every_served_section()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier2);

        await _host.AddFullCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-4)),
            DateTimeOffset.UtcNow.AddMinutes(-4),
            minFreeDiskPercent: 2d,
            worstDiskHealth: DiskHealthStatus.Watch);

        await tab.LoadAsync(cabinet.Id);

        Assert.Null(tab.ErrorMessage);

        // Overview: identity from the cabinet record, readings from the payload.
        Assert.True(tab.Overview.Availability.HasData);
        Assert.Equal(cabinet.Hostname, tab.Overview.Hostname);
        Assert.Equal("Northgate Veterinary", tab.Overview.Client);
        Assert.Equal("Pharmacy", tab.Overview.Department);
        Assert.Equal("Windows 10 Enterprise LTSC 21H2", tab.Overview.OsVersion);
        Assert.Contains("2 days", tab.Overview.Uptime);
        Assert.Equal("Nobody is logged on", tab.Overview.LoggedOn.Label);

        // Performance.
        Assert.True(tab.Performance.Availability.HasData);
        Assert.Equal("17.5%", tab.Performance.CpuPercent);
        Assert.Equal("62.3%", tab.Performance.RamUsedPercent);
        Assert.Equal("16 GB", tab.Performance.RamTotal);

        // Services, including the one with no reported status.
        Assert.True(tab.Services.Availability.HasData);
        Assert.Equal(5, tab.Services.TotalCount);
        Assert.Equal(1, tab.Services.AutoStartStoppedCount);

        ServiceRow unreported = tab.Services.Services.Single(s => s.ServiceName == "W32Time");
        Assert.Equal("Not reported", unreported.State.Label);
        Assert.False(unreported.IsAutoStartButStopped);

        // Disk.
        Assert.True(tab.Disk.Availability.HasData);
        Assert.Equal(2, tab.Disk.Volumes.Count);

        VolumeRow nearlyFull = tab.Disk.Volumes.Single(v => v.VolumeId == "D");
        Assert.Equal("Critically low", nearlyFull.Space.Label);

        // Windows Update.
        Assert.True(tab.WindowsUpdate.Availability.HasData);
        Assert.Equal("3", tab.WindowsUpdate.PendingCount);
        Assert.Equal("Reboot pending", tab.WindowsUpdate.RebootPending.Label);
        Assert.Contains("2 pending security updates", tab.WindowsUpdate.SecurityPending.Label);
    }

    /// <summary>
    /// The most important negative case in this tab: a section with no data must
    /// say why, and must never show a zero that reads as a measurement.
    /// </summary>
    [Fact]
    public async Task A_cabinet_that_has_never_checked_in_shows_the_reason_not_zeroes()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier2);

        await tab.LoadAsync(cabinet.Id);

        Assert.Null(tab.ErrorMessage);

        foreach (MachineSectionViewModel section in tab.Sections)
        {
            Assert.False(section.Availability.HasData);
            Assert.NotEmpty(section.Availability.Reason);

            // Event logs and the process list are on-demand whether or not a
            // cabinet has checked in, so their reason is the action to run
            // rather than the absence of telemetry. Everything else is simply
            // "nothing collected yet".
            Assert.Equal(
                section == tab.EventLogs || section == tab.Processes
                    ? SectionAvailabilityKind.OnDemandOnly
                    : SectionAvailabilityKind.NoCheckIn,
                section.Availability.Kind);
        }

        // Identity is still real and still shown; only the readings are absent.
        Assert.Equal(cabinet.Hostname, tab.Overview.Hostname);
        Assert.Equal("Not reported", tab.Overview.OsVersion);
        Assert.Equal("Not reported", tab.Performance.CpuPercent);
        Assert.Equal("Not reported", tab.WindowsUpdate.PendingCount);
        Assert.Equal("Never", tab.Overview.LastCheckInAge);
    }

    /// <summary>
    /// Sections that arrive on request say which action fetches them, rather
    /// than drawing an empty panel that reads as a quiet machine.
    /// </summary>
    /// <remarks>
    /// Event logs and process lists are large, change constantly, and are read
    /// for one cabinet at a time by somebody already looking at it — so they
    /// travel on an action, not on a check-in every five minutes from seven
    /// thousand cabinets. That is a deliberate design, not a gap, and the
    /// wording has to say so.
    /// </remarks>
    [Fact]
    public async Task Sections_fetched_on_request_name_the_action_rather_than_appearing_empty()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier2);

        await _host.AddFullCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-2)),
            DateTimeOffset.UtcNow.AddMinutes(-2));

        await tab.LoadAsync(cabinet.Id);

        Assert.Equal(SectionAvailabilityKind.OnDemandOnly, tab.EventLogs.Availability.Kind);
        Assert.Contains("collected on request",
            tab.EventLogs.Availability.Reason, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Run an event log view",
            tab.EventLogs.Availability.Reason, StringComparison.OrdinalIgnoreCase);

        // The process list is its own section now rather than a panel inside
        // Performance, because ending a process is an action that belongs
        // beside the row it acts on.
        Assert.Equal(SectionAvailabilityKind.OnDemandOnly, tab.Processes.Availability.Kind);
        Assert.Contains("View process list",
            tab.Processes.Availability.Reason, StringComparison.OrdinalIgnoreCase);

        Assert.Equal(SectionAvailabilityKind.OnDemandOnly, tab.Performance.ProcessListAvailability.Kind);

        // Both say so up front. An empty panel and a healthy cabinet look the
        // same, and only one of them is good news.
        Assert.Equal(2, tab.OnDemandSectionCount);
        Assert.NotNull(tab.OnDemandSectionNote);
    }

    /// <summary>
    /// Network and System are filled from the inventory tier, which Ruling 8
    /// requires the server to store in full.
    /// </summary>
    [Fact]
    public async Task Network_and_system_render_what_the_inventory_tier_carried()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier2);

        await _host.AddFullCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-2)),
            DateTimeOffset.UtcNow.AddMinutes(-2));

        await tab.LoadAsync(cabinet.Id);

        Assert.True(tab.Network.Availability.HasData);
        Assert.Equal(2, tab.Network.Adapters.Count);

        // The unplugged adapter is listed rather than filtered out: a cabinet
        // on the wrong port is exactly what a rep opening this section wants.
        Assert.Contains(tab.Network.Adapters, a => a.Status == NetworkAdapterStatus.Down);

        Assert.True(tab.System.Availability.HasData);
        Assert.Equal("Windows 10 Enterprise LTSC 21H2", tab.System.OsVersion);
        Assert.Equal("19044.3086", tab.System.OsBuild);
        Assert.Equal("NORTHGATE", tab.System.Domain);
        Assert.Equal("Europe/London", tab.System.TimeZone);
    }

    /// <summary>
    /// The sections appear in the order support staff are taught to read them.
    /// </summary>
    /// <remarks>
    /// Processes now sits between Performance and Services, which is where a
    /// rep looks next: the performance counters say the machine is busy,
    /// Processes says what is making it busy, and Services says whether the
    /// thing that should be running is. The order is fixed rather than
    /// user-sortable so that one engineer can describe a cabinet to another
    /// over the phone.
    /// </remarks>
    [Fact]
    public async Task All_nine_sections_are_present_in_the_order_the_brief_sets()
    {
        (MachineTabViewModel tab, _, _, _) = await SignedInTabAsync(Role.Tier1);

        Assert.Equal(
            new[]
            {
                "Overview", "Performance", "Processes", "Services", "Disk",
                "Windows Update", "Event Logs", "Network", "System"
            },
            tab.Sections.Select(s => s.Title).ToArray());
    }

    [Fact]
    public async Task The_auto_start_but_stopped_filter_narrows_to_the_service_that_matters()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier2);

        await _host.AddFullCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-1)),
            DateTimeOffset.UtcNow.AddMinutes(-1));

        await tab.LoadAsync(cabinet.Id);

        Assert.Equal(5, tab.Services.Services.Count);

        tab.Services.ShowOnlyAutoStartStopped = true;

        ServiceRow only = Assert.Single(tab.Services.Services);
        Assert.Equal("MashuraDispenseController", only.ServiceName);
        Assert.Contains("Showing 1 of 5", tab.Services.FilterSummary);

        tab.Services.ShowOnlyAutoStartStopped = false;
        tab.Services.FilterText = "spool";

        ServiceRow found = Assert.Single(tab.Services.Services);
        Assert.Equal("Spooler", found.ServiceName);
    }

    [Fact]
    public async Task SMART_counters_a_drive_does_not_report_stay_absent_rather_than_becoming_zero()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier1);

        DateTimeOffset now = DateTimeOffset.UtcNow;

        await _host.AddFullCheckInAsync(
            cabinet.Id, TestData.Payload(cabinet.MachineId, now.AddMinutes(-1)), now.AddMinutes(-1));

        await _host.AddSmartReadingsAsync(cabinet.Id, new[]
        {
            TestData.NvmeReading("NVME-0001", now.AddMinutes(-1))
        });

        await tab.LoadAsync(cabinet.Id);

        SmartRow nvme = Assert.Single(tab.Disk.Drives);

        Assert.Equal("7%", nvme.Wear);
        Assert.Equal("1,204", nvme.ReadErrorsTotal);
        Assert.Equal("58 \u00b0C", nvme.TemperatureMax);

        // The whole point: a rotational counter an NVMe module never reports
        // must read as unreported, not as a clean zero.
        Assert.Equal("Not reported", nvme.ReallocatedSectors);
        Assert.Equal("Not reported", nvme.PendingSectors);

        // And the row says which source the numbers came from, because a
        // structured reliability counter and a value decoded out of a
        // vendor-specific byte array are not the same measurement.
        Assert.Equal("Storage reliability counters", nvme.Source);
    }

    [Fact]
    public async Task A_rising_reallocated_sector_count_is_trended_and_described_in_words()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier1);

        DateTimeOffset now = DateTimeOffset.UtcNow;

        await _host.AddFullCheckInAsync(
            cabinet.Id, TestData.Payload(cabinet.MachineId, now.AddMinutes(-1)), now.AddMinutes(-1));

        await _host.AddSmartReadingsAsync(
            cabinet.Id, TestData.RisingReallocations("SATA-0001", now.AddDays(-6), 7));

        await tab.LoadAsync(cabinet.Id);

        Assert.NotNull(tab.Disk.SelectedDrive);
        Assert.Equal("SATA-0001", tab.Disk.SelectedDrive!.DriveSerial);

        // The trend is fetched from the server's smart-history endpoint.
        Assert.True(tab.Disk.History.Count >= 7,
            $"expected the 7-day history, got {tab.Disk.History.Count}");

        SmartTrendSeries reallocations =
            tab.Disk.TrendSeries.Single(s => s.Name == "Reallocated sectors");

        Assert.StartsWith("Rising", reallocations.Direction);
        Assert.Equal(0d, reallocations.First);
        Assert.Equal(48d, reallocations.Last);

        // A counter this drive never reports is left out of the trend rather
        // than drawn as a flat line at zero.
        Assert.DoesNotContain(tab.Disk.TrendSeries, s => s.Name == "Available spare %");
    }

    [Fact]
    public async Task Actions_sit_in_the_section_they_relate_to_and_nowhere_else()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Supervisor);

        await tab.LoadAsync(cabinet.Id);

        Assert.Equal(
            new[]
            {
                ActionName.RestartService,
                ActionName.StartService,
                ActionName.StopService,
                ActionName.SetServiceStartType,
            },
            tab.Services.Actions.Select(a => a.Catalogue.Action).ToArray());

        Assert.Equal(
            new[]
            {
                ActionName.ScanForUpdates,
                ActionName.ScheduleUpdates,
                ActionName.InstallUpdatesNow,
                ActionName.CancelScheduledUpdates,
                ActionName.GetScheduledUpdates,
            },
            tab.WindowsUpdate.Actions.Select(a => a.Catalogue.Action).ToArray());

        Assert.Equal(
            new[]
            {
                ActionName.FlushDnsCache,
                ActionName.RenewDhcpLease,
                ActionName.PingHost,
                ActionName.TraceRoute,
                ActionName.TestPortConnectivity,
                ActionName.SetDnsServers,
                ActionName.SetStaticIpAddress,
                ActionName.SetAdapterToDhcp,
            },
            tab.Network.Actions.Select(a => a.Catalogue.Action).ToArray());

        Assert.Contains(tab.System.Actions, a => a.Catalogue.Action == ActionName.RebootMachine);

        // Disk has none, deliberately.
        Assert.Empty(tab.Disk.Actions);
        Assert.Empty(tab.Overview.Actions);

        // And no action anywhere accepts free text: every parameter key the
        // console can send is one the server's catalogue named.
        foreach (SectionActionViewModel action in tab.Sections.SelectMany(s => s.Actions))
        {
            IReadOnlyDictionary<string, string> parameters =
                action.ParameterFactory?.Invoke() ?? new Dictionary<string, string>();

            Assert.All(parameters.Keys, key =>
                Assert.Contains(key, action.Catalogue.AllowedParameterKeys));
        }
    }

    /// <summary>
    /// A Tier 1 rep is offered the disruptive actions, and is told what they
    /// cost before pressing one.
    /// </summary>
    /// <remarks>
    /// This replaces a test that asserted the button was disabled for the role.
    /// Reps work any cabinet at any time; the control on a reboot is that a
    /// second person has to approve it, not that some reps cannot ask. What has
    /// not changed, and is what this now pins, is that the consequence is on
    /// the button before it is pressed rather than only inside the dialog
    /// afterwards.
    /// </remarks>
    [Fact]
    public async Task A_tier1_user_is_offered_reboot_and_told_its_consequence_on_the_button()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier1);

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel reboot =
            tab.System.Actions.Single(a => a.Catalogue.Action == ActionName.RebootMachine);

        Assert.True(reboot.RoleAllows);

        Assert.Contains("disruptive", reboot.AccessibleName, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("second person", reboot.AccessibleName, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_service_action_is_disabled_until_a_service_row_is_selected()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Supervisor);

        await _host.AddFullCheckInAsync(
            cabinet.Id, TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-1)),
            DateTimeOffset.UtcNow.AddMinutes(-1));

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel restart = tab.Services.Actions
            .Single(a => a.Catalogue.Action == ActionName.RestartService);

        Assert.False(restart.IsContextSatisfied);
        Assert.Equal("Select a row first.", restart.UnavailableReason);

        tab.Services.SelectedService =
            tab.Services.Services.Single(s => s.ServiceName == "MashuraDispenseController");

        Assert.True(restart.IsContextSatisfied);
        Assert.Null(restart.UnavailableReason);

        Assert.Equal(
            "MashuraDispenseController",
            tab.Services.CurrentServiceParameters()["serviceName"]);
    }

    [Fact]
    public async Task Requesting_a_reboot_reaches_the_server_and_the_result_is_announced()
    {
        ScriptedActionDialog dialog = ScriptedActionDialog.Accepting("Cabinet unresponsive since 09:10");

        (MachineTabViewModel tab, Cabinet cabinet, RecordingLiveRegionAnnouncer announcer, _) =
            await SignedInTabAsync(Role.Supervisor, dialog);

        // Nobody logged on: the safety gate the server enforces on reboot.
        await _host.AddFullCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-1), anyUserLoggedOn: false),
            DateTimeOffset.UtcNow.AddMinutes(-1));

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel reboot =
            tab.System.Actions.Single(a => a.Catalogue.Action == ActionName.RebootMachine);

        await reboot.InvokeCommand.ExecuteAsync(null);

        // The dialog was shown, and it was told what it needed to warn about.
        ActionRequestPrompt prompt = Assert.Single(dialog.Prompts);
        Assert.True(prompt.Catalogue.IsDisruptive);
        Assert.True(prompt.Catalogue.RequiresApproval);
        // The full path, not the hostname. It is what the dialog restates and
        // what the operator has to confirm before anything is submitted.
        Assert.Equal(cabinet.Hostname, prompt.Path.CabinetName);
        Assert.Equal(cabinet.Id, prompt.Path.CabinetId);
        Assert.NotEmpty(prompt.Path.ClientName);
        Assert.NotEmpty(prompt.Path.SiteName);
        Assert.False(prompt.UserIsLoggedOnToCabinet);

        // Reboot is maintenance-window-only, so outside that window the server
        // refuses it. Either outcome is correct and both must be announced —
        // what must never happen is silence.
        Assert.NotEmpty(announcer.Announcements);
        Assert.True(announcer.Announcements[^1].IsImportant);

        bool accepted = await _host.WithDbAsync(async db =>
            await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions
                .AnyAsync(db.ActionRequests.Where(a => a.CabinetId == cabinet.Id)));

        if (accepted)
        {
            Assert.Contains("waiting for a second person",
                announcer.Announcements[^1].Message, StringComparison.OrdinalIgnoreCase);
        }
        else
        {
            Assert.Contains("refused",
                announcer.Announcements[^1].Message, StringComparison.OrdinalIgnoreCase);
            Assert.NotNull(tab.ErrorMessage);
        }
    }

    [Fact]
    public async Task Cancelling_the_dialog_submits_nothing()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) =
            await SignedInTabAsync(Role.Supervisor, ScriptedActionDialog.Cancelling());

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel scan = tab.WindowsUpdate.Actions
            .Single(a => a.Catalogue.Action == ActionName.ScanForUpdates);

        await scan.InvokeCommand.ExecuteAsync(null);

        int requests = await _host.WithDbAsync(async db =>
            await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions
                .CountAsync(db.ActionRequests.Where(a => a.CabinetId == cabinet.Id)));

        Assert.Equal(0, requests);
        Assert.Null(tab.ErrorMessage);
    }

    [Fact]
    public async Task A_scan_for_updates_request_is_accepted_and_needs_no_approval()
    {
        (MachineTabViewModel tab, Cabinet cabinet, RecordingLiveRegionAnnouncer announcer, _) =
            await SignedInTabAsync(Role.Tier1);

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel scan = tab.WindowsUpdate.Actions
            .Single(a => a.Catalogue.Action == ActionName.ScanForUpdates);

        Assert.True(scan.RoleAllows);
        Assert.False(scan.RequiresApproval);

        await scan.InvokeCommand.ExecuteAsync(null);

        Assert.Null(tab.ErrorMessage);

        ActionRequest request = await _host.WithDbAsync(async db =>
            await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions
                .FirstAsync(db.ActionRequests.Where(a => a.CabinetId == cabinet.Id)));

        Assert.Equal(ActionName.ScanForUpdates, request.Action);
        Assert.Equal("Investigating ticket SUP-1042", request.Reason);
        Assert.Equal("SUP-1042", request.TicketReference);
        Assert.NotEqual(ActionRequestStatus.PendingApproval, request.Status);

        Assert.True(announcer.Any("Scan for updates requested"));
    }

    [Fact]
    public async Task A_cabinet_that_does_not_exist_reports_the_servers_refusal_and_clears_the_panel()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(Role.Tier2);

        await _host.AddFullCheckInAsync(
            cabinet.Id, TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-1)),
            DateTimeOffset.UtcNow.AddMinutes(-1));

        await tab.LoadAsync(cabinet.Id);
        Assert.True(tab.Overview.Availability.HasData);

        await tab.LoadAsync(Guid.NewGuid());

        Assert.NotNull(tab.ErrorMessage);
        Assert.Contains("not found", tab.ErrorMessage!, StringComparison.OrdinalIgnoreCase);

        // The previous cabinet's readings must not be left on screen under the
        // new cabinet's heading.
        Assert.False(tab.Overview.Availability.HasData);
        Assert.False(tab.Services.Availability.HasData);
        Assert.Empty(tab.Services.Services);
    }
}
