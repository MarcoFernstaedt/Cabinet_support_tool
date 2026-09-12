using System.Net;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Registrations;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class AdministrationFlowTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public AdministrationFlowTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task A_machine_becomes_a_cabinet_only_when_a_Supervisor_approves_it()
    {
        (HttpClient supervisor, User supervisorUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        string machineId = Unique("newmachine");
        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        {
            MachineId = machineId,
            // The agent names itself. It does not get to name its clinic.
            Hostname = "VET-CAB-07",
            OsVersion = "Windows 11 23H2",
            AgentVersion = "1.4.2"
        });

        var pending = await (await supervisor.GetAsync("/api/registrations/pending?pageSize=200"))
            .ReadAsync<PagedResult<PendingRegistrationDto>>();

        PendingRegistrationDto row = Assert.Single(pending!.Items, r => r.MachineId == machineId);

        HttpResponseMessage approved = await supervisor.PostJsonAsync(
            $"/api/registrations/{row.Id}/approve",
            new ApproveRegistrationRequest
            {
                ClientName = "Riverside Veterinary",
                SiteName = "Riverside Main",
                DepartmentName = "Surgery",
                Role = CabinetRole.Sync,
                Model = "CUBEX MiniStation",
                SerialNumber = "SN-99887",
                TicketReference = "SUP-5001"
            });

        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);

        Cabinet cabinet = await _factory.WithDbAsync(db => db.Cabinets
            .AsNoTracking()
            .Include(c => c.Site)!
            .ThenInclude(s => s!.Client)
            .FirstAsync(c => c.MachineId == machineId));

        // Client, site, department and role came from the Supervisor's request
        // body, never from anything the agent asserted about itself.
        Assert.Equal("Riverside Veterinary", cabinet.Site!.Client!.Name);
        Assert.Equal("Riverside Main", cabinet.Site.Name);
        Assert.Equal("Surgery", cabinet.DepartmentName);
        Assert.Equal(CabinetRole.Sync, cabinet.Role);
        Assert.Equal(supervisorUser.Id, cabinet.ApprovedByUserId);

        // A site holds exactly one sync cabinet, and this is now it.
        Guid? syncCabinetId = await _factory.WithDbAsync(db => db.Sites
            .AsNoTracking()
            .Where(s => s.Id == cabinet.SiteId)
            .Select(s => s.SyncCabinetId)
            .FirstAsync());

        Assert.Equal(cabinet.Id, syncCabinetId);

        // And now, and only now, its check-ins are accepted.
        HttpResponseMessage checkIn = await agent.PostJsonAsync(
            "/api/agent/checkin",
            new CheckInPayload
            {
                AgentVersion = "1.4.2",
                MachineId = machineId,
                CabinetId = cabinet.Id,
                CollectedAtUtc = DateTimeOffset.UtcNow,
                Performance = new PerformanceInfo { CpuTotalPercent = 10, RamUsedPercent = 40 },
                System = new SystemInfo
                {
                    Hostname = "VET-CAB-07",
                    OsVersion = "Windows 11 23H2",
                    AnyUserLoggedOn = false
                }
            });

        Assert.Equal(HttpStatusCode.OK, checkIn.StatusCode);

        Domain.AuditEntry record = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.ApproveRegistration && a.CabinetId == cabinet.Id)
            .FirstAsync());

        Assert.Equal(AuditEventKind.Caused, record.EventKind);
        Assert.Equal("SUP-5001", record.TicketReference);
    }

    [Fact]
    public async Task A_rejected_machine_stays_rejected_however_often_it_asks()
    {
        (HttpClient supervisor, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        string machineId = Unique("rejected");
        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        {
            MachineId = machineId,
            Hostname = "UNKNOWN-PC",
            OsVersion = "Windows 11 23H2",
            AgentVersion = "1.4.2"
        });

        PendingRegistration registration = await _factory.WithDbAsync(db =>
            db.PendingRegistrations.AsNoTracking().FirstAsync(r => r.MachineId == machineId));

        HttpResponseMessage rejected = await supervisor.PostJsonAsync(
            $"/api/registrations/{registration.Id}/reject",
            new RejectRegistrationRequest { Reason = "Not a machine we recognise." });

        Assert.Equal(HttpStatusCode.NoContent, rejected.StatusCode);

        // Asking again must not reset the decision back into the queue.
        HttpResponseMessage retried = await agent.PostJsonAsync(
            "/api/agent/register",
            new RegistrationRequest
            {
                MachineId = machineId,
                Hostname = "UNKNOWN-PC",
                OsVersion = "Windows 11 23H2",
                AgentVersion = "1.4.2"
            });

        RegistrationResponse? body = await retried.ReadAsync<RegistrationResponse>();

        Assert.Equal(RegistrationStatus.Rejected, body!.Status);

        RegistrationStatus status = await _factory.WithDbAsync(db => db.PendingRegistrations
            .AsNoTracking().Where(r => r.MachineId == machineId).Select(r => r.Status).FirstAsync());

        Assert.Equal(RegistrationStatus.Rejected, status);
    }

    [Fact]
    public async Task A_created_user_must_change_the_password_a_Supervisor_chose_for_them()
    {
        (HttpClient supervisor, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        string username = Unique("newuser");

        HttpResponseMessage created = await supervisor.PostJsonAsync("/api/users", new CreateUserRequest
        {
            Username = username,
            DisplayName = "New Technician",
            InitialPassword = "Initial!Password9",
            Role = Role.Tier1
        });

        Assert.Equal(HttpStatusCode.Created, created.StatusCode);

        UserDto? dto = await created.ReadAsync<UserDto>();

        Assert.True(dto!.MustChangePassword);

        // A new account never starts with elevated access, whatever was asked.
        Assert.False(dto.HasElevatedSql);
    }

    [Fact]
    public async Task A_weak_initial_password_is_refused()
    {
        (HttpClient supervisor, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        HttpResponseMessage response = await supervisor.PostJsonAsync("/api/users", new CreateUserRequest
        {
            Username = Unique("weak"),
            DisplayName = "Weak Password User",
            InitialPassword = "password",
            Role = Role.Tier1
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Granting_elevated_sql_records_the_stated_reason()
    {
        (HttpClient supervisor, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        (_, User target) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("target"));

        const string reason = "Temporary access for the dispense-log reconciliation in SUP-6000.";

        HttpResponseMessage granted = await supervisor.PostJsonAsync(
            $"/api/users/{target.Id}/elevated-sql",
            new ElevatedSqlRequest { Grant = true, Reason = reason, TicketReference = "SUP-6000" });

        Assert.Equal(HttpStatusCode.OK, granted.StatusCode);

        bool hasElevated = await _factory.WithDbAsync(db => db.Users
            .AsNoTracking().Where(u => u.Id == target.Id).Select(u => u.HasElevatedSql).FirstAsync());

        Assert.True(hasElevated);

        Domain.AuditEntry record = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.GrantElevatedSql)
            .OrderByDescending(a => a.TimestampUtc)
            .FirstAsync());

        Assert.Equal(reason, record.Reason);
        Assert.Equal("SUP-6000", record.TicketReference);

        // And revoking it is just as recordable.
        await supervisor.PostJsonAsync(
            $"/api/users/{target.Id}/elevated-sql",
            new ElevatedSqlRequest { Grant = false, Reason = "Reconciliation complete." });

        bool stillElevated = await _factory.WithDbAsync(db => db.Users
            .AsNoTracking().Where(u => u.Id == target.Id).Select(u => u.HasElevatedSql).FirstAsync());

        Assert.False(stillElevated);
    }

    [Fact]
    public async Task A_Supervisor_cannot_demote_or_deactivate_themselves()
    {
        (HttpClient supervisor, User self) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        Assert.Equal(HttpStatusCode.BadRequest,
            (await supervisor.PatchJsonAsync($"/api/users/{self.Id}",
                new UpdateUserRequest { Role = Role.Tier1 })).StatusCode);

        Assert.Equal(HttpStatusCode.BadRequest,
            (await supervisor.PatchJsonAsync($"/api/users/{self.Id}",
                new UpdateUserRequest { IsActive = false })).StatusCode);
    }

    [Fact]
    public async Task Fleet_health_counts_a_silent_cabinet_as_offline()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("t1"));

        const string clientName = "Offline Test Client";

        Cabinet stale = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("stale"), user.Id, clientName: clientName, siteName: "Site A");

        await _factory.WithDbAsync(async db =>
        {
            Cabinet tracked = await db.Cabinets.FirstAsync(c => c.Id == stale.Id);

            // Long past the configured offline threshold.
            tracked.LastCheckInUtc = DateTimeOffset.UtcNow.AddHours(-6);

            await db.SaveChangesAsync();
        });

        var summary = await (await client.GetAsync(
                $"/api/fleet/health?clientName={Uri.EscapeDataString(clientName)}"))
            .ReadAsync<FleetHealthSummary>();

        Assert.NotNull(summary);
        Assert.Equal(1, summary!.TotalCabinets);
        Assert.Equal(1, summary.Offline);
        Assert.Equal(0, summary.Healthy);
    }

    [Fact]
    public async Task The_audit_endpoint_filters_by_event_kind()
    {
        (HttpClient supervisor, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        var caused = await (await supervisor.GetAsync("/api/audit?eventKind=Caused&pageSize=200"))
            .ReadAsync<PagedResult<AuditEntryDto>>();

        var observed = await (await supervisor.GetAsync("/api/audit?eventKind=Observed&pageSize=200"))
            .ReadAsync<PagedResult<AuditEntryDto>>();

        Assert.NotNull(caused);
        Assert.NotNull(observed);
        Assert.All(caused!.Items, e => Assert.Equal(AuditEventKind.Caused, e.EventKind));
        Assert.All(observed!.Items, e => Assert.Equal(AuditEventKind.Observed, e.EventKind));
    }

    [Fact]
    public async Task A_history_range_wider_than_policy_is_refused_rather_than_clamped()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("t1"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("range"), user.Id);

        string from = Uri.EscapeDataString(DateTimeOffset.UtcNow.AddYears(-3).ToString("O"));
        string to = Uri.EscapeDataString(DateTimeOffset.UtcNow.ToString("O"));

        HttpResponseMessage response = await client.GetAsync(
            $"/api/cabinets/{cabinet.Id}/heartbeats?fromUtc={from}&toUtc={to}");

        // Silently clamping would hand back a partial answer that looks whole.
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        Assert.True(await TestClient.CountAuditAsync(
            _factory, AuditEvent.ViewCabinetHistory, AuditResult.Denied) > 0);
    }

    [Fact]
    public async Task The_health_endpoint_is_reachable_without_a_credential()
    {
        HttpClient client = _factory.CreateClient();

        HttpResponseMessage response = await client.GetAsync("/health");

        // A probe that needs a credential reports the wrong thing the day the
        // credential expires.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
