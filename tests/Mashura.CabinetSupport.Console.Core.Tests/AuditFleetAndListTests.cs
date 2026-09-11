using Mashura.CabinetSupport.Console.Core.Api;
using Mashura.CabinetSupport.Console.Core.Presentation;
using Mashura.CabinetSupport.Console.Core.Rows;
using Mashura.CabinetSupport.Console.Core.ViewModels;
using Mashura.CabinetSupport.Contracts.Enums;
using Mashura.CabinetSupport.Contracts.Users;
using Mashura.CabinetSupport.Server.Domain;

namespace Mashura.CabinetSupport.Console.Core.Tests;

/// <summary>
/// The cabinet list, the audit trail and the fleet view against the real server.
/// </summary>
public sealed class AuditFleetAndListTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;

    public AuditFleetAndListTests(ConsoleTestHost host) => _host = host;

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];

    private async Task<(ApiClient Api, SessionStore Session)> SignInAsync(UserRole role)
    {
        string username = Unique(role.ToString().ToLowerInvariant());
        await _host.CreateUserAsync(role, username);

        (ApiClient api, SessionStore session) = _host.CreateConsole();

        await api.LoginAsync(
            new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword },
            CancellationToken.None);

        return (api, session);
    }

    // --- Cabinet list ----------------------------------------------------

    [Fact]
    public async Task The_cabinet_list_loads_paged_and_filters_by_client()
    {
        string client = Unique("Clinic");

        for (int i = 0; i < 3; i++)
        {
            await _host.CreateCabinetAsync($"LIST-{client[..8]}-{i}", client, "Site A");
        }

        await _host.CreateCabinetAsync($"OTHER-{Unique("x")[..6]}", Unique("Elsewhere"), "Site B");

        (ApiClient api, _) = await SignInAsync(UserRole.Tier1);
        RecordingLiveRegionAnnouncer announcer = new();

        var list = new CabinetListViewModel(api, announcer, TimeProvider.System)
        {
            ClientFilter = client,
            PageSize = 25
        };

        await list.LoadAsync();

        Assert.Null(list.ErrorMessage);
        Assert.Equal(3, list.Cabinets.Count);
        Assert.All(list.Cabinets, row => Assert.Equal(client, row.ClientName));

        // Selecting a row moves the detail pane, so it is announced.
        Assert.NotNull(list.SelectedCabinet);
        Assert.True(announcer.Any("Cabinet list loaded"));
        Assert.True(announcer.Any("Selected"));
        Assert.Contains($"client {client}", list.DescribeFilters());
    }

    [Fact]
    public async Task Selecting_a_cabinet_raises_the_selection_event_the_shell_listens_for()
    {
        string client = Unique("SelClinic");
        Cabinet cabinet = await _host.CreateCabinetAsync($"SEL-{Unique("s")[..6]}", client, "Site A");

        (ApiClient api, _) = await SignInAsync(UserRole.Tier1);

        var list = new CabinetListViewModel(api, NullLiveRegionAnnouncer.Instance, TimeProvider.System)
        {
            ClientFilter = client
        };

        List<Guid?> selections = new();
        list.SelectionChanged += (_, id) => selections.Add(id);

        await list.LoadAsync();

        Assert.Contains(cabinet.Id, selections);
    }

    [Fact]
    public async Task A_cabinet_row_reads_as_one_sentence_and_never_as_a_bare_colour()
    {
        string client = Unique("RowClinic");

        Cabinet cabinet = await _host.CreateCabinetAsync($"ROW-{Unique("r")[..6]}", client, "Site A");

        await _host.AddCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTime.UtcNow.AddMinutes(-3)),
            DateTime.UtcNow.AddMinutes(-3),
            worstDiskHealth: DiskHealthStatus.Warning);

        (ApiClient api, _) = await SignInAsync(UserRole.Tier1);

        var list = new CabinetListViewModel(api, NullLiveRegionAnnouncer.Instance, TimeProvider.System)
        {
            ClientFilter = client
        };

        await list.LoadAsync();

        CabinetRow row = Assert.Single(list.Cabinets);

        // Every status carries a word and a shape, so none of them depends on a
        // colour the user may not be able to see.
        Assert.NotEmpty(row.Health.Label);
        Assert.NotEmpty(row.Health.Glyph);
        Assert.Equal("Watch", row.DiskHealth.Label);
        Assert.NotEmpty(row.DiskHealth.Glyph);

        Assert.Contains(row.Hostname, row.AccessibleSummary);
        Assert.Contains("Disk Watch", row.AccessibleSummary);
        Assert.Contains("Health", row.AccessibleSummary);
    }

    // --- Audit -----------------------------------------------------------

    [Fact]
    public async Task A_supervisor_can_read_the_audit_trail_and_filter_observed_from_caused()
    {
        (ApiClient api, _) = await SignInAsync(UserRole.Supervisor);

        // Generate traffic: reads produce Observed entries.
        await api.GetCabinetsAsync(new Contracts.Cabinets.CabinetQuery(), CancellationToken.None);
        await api.GetCurrentUserAsync(CancellationToken.None);

        var audit = new AuditTabViewModel(api, new RecordingLiveRegionAnnouncer(), TimeProvider.System);

        await audit.LoadAsync();

        Assert.False(audit.IsForbidden);
        Assert.Null(audit.ErrorMessage);
        Assert.NotEmpty(audit.Entries);

        audit.EventKind = AuditEventKind.Observed;
        await audit.SearchCommand.ExecuteAsync(null);

        Assert.NotEmpty(audit.Entries);
        Assert.All(audit.Entries, e => Assert.Equal("Observed", e.Kind.Label));

        // Observed and Caused get distinct words and distinct shapes.
        Assert.NotEqual(
            StatusPresentation.ForAuditKind(AuditEventKind.Observed).Glyph,
            StatusPresentation.ForAuditKind(AuditEventKind.Caused).Glyph);

        Assert.Contains("Observed", audit.DescribeFilters());
    }

    [Fact]
    public async Task An_action_request_shows_up_in_the_audit_trail_as_caused()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"AUD-{Unique("a")[..6]}");

        (ApiClient supervisorApi, _) = await SignInAsync(UserRole.Supervisor);

        await supervisorApi.CreateActionAsync(
            new Contracts.Actions.CreateActionRequest
            {
                Action = CabinetActionType.ScanForUpdates,
                CabinetId = cabinet.Id,
                Reason = "Checking patch level for ticket SUP-3001",
                TicketReference = "SUP-3001"
            },
            CancellationToken.None);

        var audit = new AuditTabViewModel(
            supervisorApi, new RecordingLiveRegionAnnouncer(), TimeProvider.System)
        {
            EventKind = AuditEventKind.Caused
        };

        await audit.ShowForCabinetAsync(cabinet.Id);

        Assert.NotEmpty(audit.Entries);
        Assert.All(audit.Entries, e => Assert.Equal("Caused", e.Kind.Label));
        Assert.Contains(audit.Entries, e => e.Ticket == "SUP-3001");
    }

    [Fact]
    public async Task A_tier2_user_is_told_the_audit_trail_is_supervisor_only()
    {
        (ApiClient api, _) = await SignInAsync(UserRole.Tier2);

        var audit = new AuditTabViewModel(api, new RecordingLiveRegionAnnouncer(), TimeProvider.System);

        await audit.LoadAsync();

        Assert.True(audit.IsForbidden);
        Assert.Empty(audit.Entries);
        Assert.Contains("Supervisors", audit.ForbiddenExplanation);
    }

    [Fact]
    public async Task An_inverted_date_range_surfaces_the_servers_refusal_rather_than_an_empty_grid()
    {
        (ApiClient api, _) = await SignInAsync(UserRole.Supervisor);

        var audit = new AuditTabViewModel(api, new RecordingLiveRegionAnnouncer(), TimeProvider.System);

        audit.FromLocal = DateTime.Now;
        audit.ToLocal = DateTime.Now.AddDays(-3);

        await audit.LoadAsync();

        Assert.False(audit.IsForbidden);
        Assert.NotNull(audit.ErrorMessage);
        Assert.Contains("earlier", audit.ErrorMessage!, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(audit.Entries);
    }

    [Fact]
    public async Task A_range_wider_than_the_server_allows_is_refused_in_the_servers_own_words()
    {
        (ApiClient api, _) = await SignInAsync(UserRole.Supervisor);

        var audit = new AuditTabViewModel(api, new RecordingLiveRegionAnnouncer(), TimeProvider.System);

        audit.FromLocal = DateTime.Now.AddDays(-400);
        audit.ToLocal = DateTime.Now;

        await audit.LoadAsync();

        Assert.NotNull(audit.ErrorMessage);
        Assert.Contains("maximum", audit.ErrorMessage!, StringComparison.OrdinalIgnoreCase);
    }

    // --- Fleet -----------------------------------------------------------

    [Fact]
    public async Task The_fleet_view_builds_the_three_worklists_from_real_cabinet_data()
    {
        string client = Unique("FleetClinic");
        DateTime now = DateTime.UtcNow;

        // Healthy and recent.
        Cabinet healthy = await _host.CreateCabinetAsync($"FL-OK-{Unique("o")[..5]}", client, "Site A");
        await _host.AddCheckInAsync(
            healthy.Id,
            TestData.Payload(healthy.MachineId, now.AddMinutes(-2), pendingUpdates: 0),
            now.AddMinutes(-2));

        // Has pending updates.
        Cabinet patchy = await _host.CreateCabinetAsync($"FL-UP-{Unique("u")[..5]}", client, "Site A");
        await _host.AddCheckInAsync(
            patchy.Id,
            TestData.Payload(patchy.MachineId, now.AddMinutes(-3), pendingUpdates: 11),
            now.AddMinutes(-3));

        // Failing drive.
        Cabinet failing = await _host.CreateCabinetAsync($"FL-DK-{Unique("d")[..5]}", client, "Site A");
        await _host.AddCheckInAsync(
            failing.Id,
            TestData.Payload(failing.MachineId, now.AddMinutes(-4), pendingUpdates: 0),
            now.AddMinutes(-4),
            worstDiskHealth: DiskHealthStatus.Critical);

        // Gone quiet.
        Cabinet stale = await _host.CreateCabinetAsync($"FL-ST-{Unique("s")[..5]}", client, "Site A");
        await _host.AddCheckInAsync(
            stale.Id,
            TestData.Payload(stale.MachineId, now.AddHours(-9), pendingUpdates: 0),
            now.AddHours(-9));

        // Approved but never heard from — the most urgent kind of silence.
        Cabinet never = await _host.CreateCabinetAsync($"FL-NV-{Unique("n")[..5]}", client, "Site A");

        (ApiClient api, _) = await SignInAsync(UserRole.Tier1);
        RecordingLiveRegionAnnouncer announcer = new();

        var fleet = new FleetTabViewModel(api, announcer, TimeProvider.System)
        {
            ClientFilter = client
        };

        await fleet.LoadAsync();

        Assert.Null(fleet.ErrorMessage);
        Assert.NotNull(fleet.Summary);
        Assert.Equal(5, fleet.Summary!.TotalCabinets);

        Assert.Contains(fleet.PendingUpdates, r => r.Id == patchy.Id);
        Assert.DoesNotContain(fleet.PendingUpdates, r => r.Id == healthy.Id);

        Assert.Contains(fleet.DrivesNeedingAttention, r => r.Id == failing.Id);
        Assert.DoesNotContain(fleet.DrivesNeedingAttention, r => r.Id == healthy.Id);

        Assert.Contains(fleet.StaleCheckIns, r => r.Id == stale.Id);
        Assert.Contains(fleet.StaleCheckIns, r => r.Id == never.Id);
        Assert.DoesNotContain(fleet.StaleCheckIns, r => r.Id == healthy.Id);

        // Never-checked-in sorts first: it is the more urgent problem.
        Assert.Equal(never.Id, fleet.StaleCheckIns[0].Id);
        Assert.Equal("Never", fleet.StaleCheckIns[0].LastCheckInAge);

        Assert.False(fleet.WorklistsTruncated);
        Assert.True(announcer.Any("Fleet health"));
        Assert.Contains(client, fleet.Summarise());
    }

    [Fact]
    public async Task Disk_health_counts_keep_not_reported_separate_from_healthy()
    {
        string client = Unique("DiskClinic");
        DateTime now = DateTime.UtcNow;

        Cabinet healthy = await _host.CreateCabinetAsync($"DH-OK-{Unique("o")[..5]}", client, "Site A");
        await _host.AddCheckInAsync(
            healthy.Id, TestData.Payload(healthy.MachineId, now.AddMinutes(-1)), now.AddMinutes(-1),
            worstDiskHealth: DiskHealthStatus.Healthy);

        // No check-in at all, so no drive verdict exists for it.
        await _host.CreateCabinetAsync($"DH-NV-{Unique("n")[..5]}", client, "Site A");

        (ApiClient api, _) = await SignInAsync(UserRole.Tier1);

        var fleet = new FleetTabViewModel(api, NullLiveRegionAnnouncer.Instance, TimeProvider.System)
        {
            ClientFilter = client
        };

        await fleet.LoadAsync();

        FleetCountRow healthyCount = fleet.DiskHealthCounts.Single(c => c.Label == "Healthy");
        FleetCountRow unknownCount = fleet.DiskHealthCounts.Single(c => c.Label == "Not reported");

        Assert.Equal(1, healthyCount.Count);
        Assert.Equal(1, unknownCount.Count);

        // Every count carries its own label and shape, so the breakdown reads
        // identically to a screen reader and to the eye.
        Assert.All(fleet.DiskHealthCounts, c =>
        {
            Assert.NotEmpty(c.Label);
            Assert.NotEmpty(c.Glyph);
            Assert.Contains(c.Label, c.AccessibleSummary);
        });
    }

    [Fact]
    public async Task Fleet_counts_come_from_the_servers_own_health_evaluation()
    {
        string client = Unique("AuthClinic");

        await _host.CreateCabinetAsync($"AU-{Unique("a")[..6]}", client, "Site A");

        (ApiClient api, _) = await SignInAsync(UserRole.Tier1);

        var fleet = new FleetTabViewModel(api, NullLiveRegionAnnouncer.Instance, TimeProvider.System)
        {
            ClientFilter = client
        };

        await fleet.LoadAsync();

        // The console does not recompute health: the sum of the rolled-up counts
        // must equal what the server said the total was.
        int sum = fleet.CabinetHealthCounts
            .Where(c => c.Label != "Inactive")
            .Sum(c => c.Count);

        Assert.Equal(fleet.Summary!.TotalCabinets, sum);
    }
}
