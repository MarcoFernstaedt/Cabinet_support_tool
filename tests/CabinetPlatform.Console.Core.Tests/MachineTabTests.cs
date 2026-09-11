using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Agent;
using CabinetPlatform.Contracts.Enums;
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
        SignedInTabAsync(UserRole role, ScriptedActionDialog? dialog = null)
    {
        string username = Unique("m");
        await _host.CreateUserAsync(role, username);

        (ApiClient api, SessionStore session) = _host.CreateConsole();

        await api.LoginAsync(
            new Contracts.Users.LoginRequest
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
    public async Task A_cabinet_with_a_check_in_renders_real_data_in_every_served_section()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier2);

        await _host.AddCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTime.UtcNow.AddMinutes(-4)),
            DateTime.UtcNow.AddMinutes(-4),
            minFreeDiskPercent: 2d,
            worstDiskHealth: DiskHealthStatus.Warning);

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

        VolumeRow nearlyFull = tab.Disk.Volumes.Single(v => v.VolumeId == "D:");
        Assert.Equal("Critically low", nearlyFull.Space.Label);

        // Windows Update.
        Assert.True(tab.WindowsUpdate.Availability.HasData);
        Assert.Equal("3", tab.WindowsUpdate.PendingCount);
        Assert.Equal("A pending update requires a reboot", tab.WindowsUpdate.RebootPending.Label);
        Assert.Contains("2 pending security updates", tab.WindowsUpdate.SecurityPending.Label);
    }

    /// <summary>
    /// The most important negative case in this tab: a section with no data must
    /// say why, and must never show a zero that reads as a measurement.
    /// </summary>
    [Fact]
    public async Task A_cabinet_that_has_never_checked_in_shows_the_reason_not_zeroes()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier2);

        await tab.LoadAsync(cabinet.Id);

        Assert.Null(tab.ErrorMessage);

        foreach (MachineSectionViewModel section in tab.Sections)
        {
            Assert.False(section.Availability.HasData);
            Assert.Equal(SectionAvailabilityKind.NoCheckIn, section.Availability.Kind);
            Assert.NotEmpty(section.Availability.Reason);
        }

        // Identity is still real and still shown; only the readings are absent.
        Assert.Equal(cabinet.Hostname, tab.Overview.Hostname);
        Assert.Equal("Not reported", tab.Overview.OsVersion);
        Assert.Equal("Not reported", tab.Performance.CpuPercent);
        Assert.Equal("Not reported", tab.WindowsUpdate.PendingCount);
        Assert.Equal("Never", tab.Overview.LastCheckInAge);
    }

    [Fact]
    public async Task Sections_this_server_cannot_fill_say_so_rather_than_appearing_empty()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier2);

        await _host.AddCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTime.UtcNow.AddMinutes(-2)),
            DateTime.UtcNow.AddMinutes(-2));

        await tab.LoadAsync(cabinet.Id);

        foreach (MachineSectionViewModel section in new MachineSectionViewModel[]
                 {
                     tab.EventLogs, tab.Network, tab.System
                 })
        {
            Assert.Equal(SectionAvailabilityKind.NotCarriedByServer, section.Availability.Kind);
            Assert.Contains("not carried by this server build",
                section.Availability.Reason, StringComparison.OrdinalIgnoreCase);

            // Says where the gap is, so nobody goes looking for a fault on the
            // cabinet that is not there.
            Assert.Contains("not a fault on the cabinet",
                section.Availability.Reason, StringComparison.OrdinalIgnoreCase);
        }

        Assert.Equal(3, tab.UnservedSectionCount);
        Assert.NotNull(tab.UnservedSectionNote);
    }

    [Fact]
    public async Task All_eight_sections_are_present_in_the_order_the_brief_sets()
    {
        (MachineTabViewModel tab, _, _, _) = await SignedInTabAsync(UserRole.Tier1);

        Assert.Equal(
            new[]
            {
                "Overview", "Performance", "Services", "Disk",
                "Windows Update", "Event Logs", "Network", "System"
            },
            tab.Sections.Select(s => s.Title).ToArray());
    }

    [Fact]
    public async Task The_auto_start_but_stopped_filter_narrows_to_the_service_that_matters()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier2);

        await _host.AddCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTime.UtcNow.AddMinutes(-1)),
            DateTime.UtcNow.AddMinutes(-1));

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
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier1);

        DateTime now = DateTime.UtcNow;

        await _host.AddCheckInAsync(
            cabinet.Id, TestData.Payload(cabinet.MachineId, now.AddMinutes(-1)), now.AddMinutes(-1));

        await _host.AddSmartReadingsAsync(cabinet.Id, new[]
        {
            TestData.NvmeReading("NVME-0001", now.AddMinutes(-1))
        });

        await tab.LoadAsync(cabinet.Id);

        SmartRow nvme = Assert.Single(tab.Disk.Drives);

        Assert.Equal("7%", nvme.PercentageUsed);
        Assert.Equal("100%", nvme.AvailableSpare);

        // The whole point: a rotational counter an NVMe module never reports
        // must read as unreported, not as a clean zero.
        Assert.Equal("Not reported", nvme.ReallocatedSectors);
        Assert.Equal("Not reported", nvme.PendingSectors);
    }

    [Fact]
    public async Task A_rising_reallocated_sector_count_is_trended_and_described_in_words()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier1);

        DateTime now = DateTime.UtcNow;

        await _host.AddCheckInAsync(
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
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Supervisor);

        await tab.LoadAsync(cabinet.Id);

        Assert.Equal(
            new[] { CabinetActionType.RestartService, CabinetActionType.StartService, CabinetActionType.StopService },
            tab.Services.Actions.Select(a => a.Catalogue.Action).ToArray());

        Assert.Equal(
            new[] { CabinetActionType.ScanForUpdates, CabinetActionType.ScheduleUpdates },
            tab.WindowsUpdate.Actions.Select(a => a.Catalogue.Action).ToArray());

        Assert.Equal(
            new[] { CabinetActionType.FlushDnsCache, CabinetActionType.RenewDhcpLease },
            tab.Network.Actions.Select(a => a.Catalogue.Action).ToArray());

        Assert.Contains(tab.System.Actions, a => a.Catalogue.Action == CabinetActionType.RebootMachine);

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

    [Fact]
    public async Task A_tier1_user_sees_why_a_tier2_action_is_unavailable()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier1);

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel reboot =
            tab.System.Actions.Single(a => a.Catalogue.Action == CabinetActionType.RebootMachine);

        Assert.False(reboot.RoleAllows);
        Assert.NotNull(reboot.UnavailableReason);
        Assert.Contains("Tier2", reboot.UnavailableReason!);

        // And the button's accessible name carries the consequence before the
        // user presses it, not only inside the dialog afterwards.
        Assert.Contains("disruptive", reboot.AccessibleName, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("second person", reboot.AccessibleName, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_service_action_is_disabled_until_a_service_row_is_selected()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Supervisor);

        await _host.AddCheckInAsync(
            cabinet.Id, TestData.Payload(cabinet.MachineId, DateTime.UtcNow.AddMinutes(-1)),
            DateTime.UtcNow.AddMinutes(-1));

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel restart = tab.Services.Actions
            .Single(a => a.Catalogue.Action == CabinetActionType.RestartService);

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
            await SignedInTabAsync(UserRole.Supervisor, dialog);

        // Nobody logged on: the safety gate the server enforces on reboot.
        await _host.AddCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTime.UtcNow.AddMinutes(-1), anyUserLoggedOn: false),
            DateTime.UtcNow.AddMinutes(-1));

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel reboot =
            tab.System.Actions.Single(a => a.Catalogue.Action == CabinetActionType.RebootMachine);

        await reboot.InvokeCommand.ExecuteAsync(null);

        // The dialog was shown, and it was told what it needed to warn about.
        ActionRequestPrompt prompt = Assert.Single(dialog.Prompts);
        Assert.True(prompt.Catalogue.IsDisruptive);
        Assert.True(prompt.Catalogue.RequiresApproval);
        Assert.Equal(cabinet.Hostname, prompt.CabinetHostname);
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
            await SignedInTabAsync(UserRole.Supervisor, ScriptedActionDialog.Cancelling());

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel scan = tab.WindowsUpdate.Actions
            .Single(a => a.Catalogue.Action == CabinetActionType.ScanForUpdates);

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
            await SignedInTabAsync(UserRole.Tier1);

        await tab.LoadAsync(cabinet.Id);

        SectionActionViewModel scan = tab.WindowsUpdate.Actions
            .Single(a => a.Catalogue.Action == CabinetActionType.ScanForUpdates);

        Assert.True(scan.RoleAllows);
        Assert.False(scan.RequiresApproval);

        await scan.InvokeCommand.ExecuteAsync(null);

        Assert.Null(tab.ErrorMessage);

        ActionRequest request = await _host.WithDbAsync(async db =>
            await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions
                .FirstAsync(db.ActionRequests.Where(a => a.CabinetId == cabinet.Id)));

        Assert.Equal(CabinetActionType.ScanForUpdates, request.Action);
        Assert.Equal("Investigating ticket SUP-1042", request.Reason);
        Assert.Equal("SUP-1042", request.TicketReference);
        Assert.NotEqual(ActionRequestStatus.PendingApproval, request.Status);

        Assert.True(announcer.Any("Scan for updates requested"));
    }

    [Fact]
    public async Task A_cabinet_that_does_not_exist_reports_the_servers_refusal_and_clears_the_panel()
    {
        (MachineTabViewModel tab, Cabinet cabinet, _, _) = await SignedInTabAsync(UserRole.Tier2);

        await _host.AddCheckInAsync(
            cabinet.Id, TestData.Payload(cabinet.MachineId, DateTime.UtcNow.AddMinutes(-1)),
            DateTime.UtcNow.AddMinutes(-1));

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
