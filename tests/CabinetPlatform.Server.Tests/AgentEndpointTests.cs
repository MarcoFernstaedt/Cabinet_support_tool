using System.Net;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// An agent reports nothing usable until a Supervisor approves it.
/// </summary>
public sealed class AgentEndpointTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public AgentEndpointTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Checkin_from_an_unapproved_machine_is_refused_and_stores_nothing()
    {
        string machineId = Unique("unapproved");
        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        // Counted before and after rather than against zero: the fixture is
        // shared with the other tests in this class, and an assertion about
        // the whole table would be measuring them instead of this one.
        int checkInsBefore = await _factory.WithDbAsync(db => db.CheckIns.AsNoTracking().CountAsync());
        int smartBefore = await _factory.WithDbAsync(db => db.SmartReadings.AsNoTracking().CountAsync());

        HttpResponseMessage response = await agent.PostJsonAsync(
            "/api/agent/checkin", SampleCheckIn(machineId));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        // Nothing from an unapproved machine reaches the fleet data.
        int checkInsAfter = await _factory.WithDbAsync(db => db.CheckIns.AsNoTracking().CountAsync());
        int smartAfter = await _factory.WithDbAsync(db => db.SmartReadings.AsNoTracking().CountAsync());

        Assert.Equal(checkInsBefore, checkInsAfter);
        Assert.Equal(smartBefore, smartAfter);

        bool becameCabinet = await _factory.WithDbAsync(db =>
            db.Cabinets.AsNoTracking().AnyAsync(c => c.MachineId == machineId));

        Assert.False(becameCabinet);

        // But the attempt itself is recorded.
        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == AuditActions.AgentCheckIn &&
                        a.Result == AuditResult.Denied &&
                        a.ActorId == machineId)
            .ToListAsync());

        Assert.NotEmpty(denials);
        Assert.All(denials, d => Assert.Equal(ActorTypes.Agent, d.ActorType));
    }

    [Fact]
    public async Task Checkin_without_a_valid_agent_key_is_rejected()
    {
        string machineId = Unique("nokey");
        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId, "wrong-secret");

        HttpResponseMessage response = await agent.PostJsonAsync(
            "/api/agent/checkin", SampleCheckIn(machineId));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);

        // Even a request that never reached a controller leaves a trace.
        int denials = await TestClient.CountAuditAsync(
            _factory, AuditActions.AuthorizationDenied, AuditResult.Denied);

        Assert.True(denials > 0);
    }

    [Fact]
    public async Task Register_creates_a_pending_registration_and_admits_nothing()
    {
        string machineId = Unique("register");
        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        HttpResponseMessage response = await agent.PostJsonAsync(
            "/api/agent/register",
            new AgentRegistrationRequest
            {
                MachineId = machineId,
                Hostname = "CLINIC-PC-01",
                OsVersion = "Windows 11 23H2",
                AgentVersion = "1.4.2"
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        AgentRegistrationResponse? body = await response.ReadAsync<AgentRegistrationResponse>();
        Assert.NotNull(body);
        Assert.Equal(RegistrationStatus.Pending, body!.Status);

        bool isCabinet = await _factory.WithDbAsync(db =>
            db.Cabinets.AsNoTracking().AnyAsync(c => c.MachineId == machineId));

        // Registering is asking. It is not being admitted.
        Assert.False(isCabinet);

        PendingRegistration registration = await _factory.WithDbAsync(db =>
            db.PendingRegistrations.AsNoTracking().FirstAsync(r => r.MachineId == machineId));

        Assert.Equal(RegistrationStatus.Pending, registration.Status);
    }

    [Fact]
    public async Task Repeated_registration_updates_one_row_rather_than_queueing_duplicates()
    {
        string machineId = Unique("repeat");
        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        for (int i = 0; i < 3; i++)
        {
            HttpResponseMessage response = await agent.PostJsonAsync(
                "/api/agent/register",
                new AgentRegistrationRequest
                {
                    MachineId = machineId,
                    Hostname = "CLINIC-PC-02",
                    AgentVersion = $"1.4.{i}"
                });

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        int rows = await _factory.WithDbAsync(db => db.PendingRegistrations
            .AsNoTracking()
            .CountAsync(r => r.MachineId == machineId));

        Assert.Equal(1, rows);
    }

    [Fact]
    public async Task An_approved_cabinet_stores_its_checkin_projection_and_smart_readings()
    {
        (_, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        string machineId = Unique("approved");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, machineId, supervisor.Id);

        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        HttpResponseMessage response = await agent.PostJsonAsync(
            "/api/agent/checkin", SampleCheckIn(machineId));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        CheckIn stored = await _factory.WithDbAsync(db =>
            db.CheckIns.AsNoTracking().FirstAsync(c => c.CabinetId == cabinet.Id));

        // The projection columns are what the fleet grid reads; the payload is
        // kept beside them for forensics.
        Assert.Equal(2, stored.PendingUpdateCount);
        Assert.True(stored.AnyUserLoggedOn);
        Assert.Equal(DiskHealthStatus.Warning, stored.WorstDiskHealth);
        Assert.InRange(stored.MinFreeDiskPercent, 7.9, 8.1);
        Assert.False(string.IsNullOrWhiteSpace(stored.PayloadJson));

        SmartReading reading = await _factory.WithDbAsync(db =>
            db.SmartReadings.AsNoTracking().FirstAsync(s => s.CabinetId == cabinet.Id));

        Assert.Equal("DRIVE-SERIAL-1", reading.DriveSerial);
        Assert.Equal(12, reading.ReallocatedSectorCount);

        // A counter the drive did not report stays null. It must never be
        // stored as a zero, which would read as good news.
        Assert.Null(reading.AvailableSparePercent);

        DateTime? lastCheckIn = await _factory.WithDbAsync(db => db.Cabinets
            .AsNoTracking().Where(c => c.Id == cabinet.Id).Select(c => c.LastCheckInUtc).FirstAsync());

        Assert.NotNull(lastCheckIn);
    }

    [Fact]
    public async Task A_repeated_checkin_with_the_same_collection_time_does_not_duplicate_rows()
    {
        (_, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        string machineId = Unique("idempotent");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, machineId, supervisor.Id);

        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);
        CheckInRequest payload = SampleCheckIn(machineId);

        HttpResponseMessage first = await agent.PostJsonAsync("/api/agent/checkin", payload);
        HttpResponseMessage second = await agent.PostJsonAsync("/api/agent/checkin", payload);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        CheckInResponse? secondBody = await second.ReadAsync<CheckInResponse>();
        Assert.True(secondBody!.WasDuplicate);

        int rows = await _factory.WithDbAsync(db =>
            db.CheckIns.AsNoTracking().CountAsync(c => c.CabinetId == cabinet.Id));

        Assert.Equal(1, rows);
    }

    [Fact]
    public async Task A_cabinet_cannot_report_a_result_for_another_cabinets_action()
    {
        (HttpClient requesterClient, User requester) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("req"));
        (HttpClient approverClient, User approver) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("app"));

        string ownerMachine = Unique("owner");
        string intruderMachine = Unique("intruder");

        Cabinet owner = await TestClient.CreateApprovedCabinetAsync(_factory, ownerMachine, approver.Id);
        await TestClient.CreateApprovedCabinetAsync(_factory, intruderMachine, approver.Id);

        HttpResponseMessage created = await requesterClient.PostJsonAsync(
            "/api/actions",
            new Contracts.Actions.CreateActionRequest
            {
                Action = ActionName.StopService,
                CabinetId = owner.Id,
                Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
                Reason = "Service is hung."
            });

        Contracts.Actions.ActionRequestDto? dto =
            await created.ReadAsync<Contracts.Actions.ActionRequestDto>();

        await approverClient.PostJsonAsync(
            $"/api/actions/{dto!.Id}/approve", new Contracts.Actions.ApproveActionRequest());

        HttpClient intruder = TestClient.CreateAgentClient(_factory, intruderMachine);

        HttpResponseMessage response = await intruder.PostJsonAsync(
            $"/api/agent/actions/{dto.Id}/result",
            new AgentActionResultRequest { Status = ActionStatus.Succeeded, Output = "done" });

        // 404 rather than 403: one cabinet should not learn that another
        // cabinet's work exists.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        ActionRequest stored = await _factory.WithDbAsync(db =>
            db.ActionRequests.AsNoTracking().FirstAsync(a => a.Id == dto.Id));

        Assert.NotEqual(ActionRequestStatus.Completed, stored.Status);

        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == AuditActions.AgentReportResult &&
                        a.Result == AuditResult.Denied &&
                        a.ActorId == intruderMachine)
            .ToListAsync());

        Assert.NotEmpty(denials);
    }

    [Fact]
    public async Task An_agent_only_collects_its_own_approved_actions_and_they_are_marked_dispatched()
    {
        (HttpClient requesterClient, User requester) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("req"));
        (HttpClient approverClient, User approver) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("app"));

        string mineMachine = Unique("mine");
        string theirsMachine = Unique("theirs");

        Cabinet mine = await TestClient.CreateApprovedCabinetAsync(_factory, mineMachine, approver.Id);
        Cabinet theirs = await TestClient.CreateApprovedCabinetAsync(_factory, theirsMachine, approver.Id);

        Guid mineAction = await ApprovedActionAsync(requesterClient, approverClient, mine.Id);
        Guid theirsAction = await ApprovedActionAsync(requesterClient, approverClient, theirs.Id);

        HttpClient agent = TestClient.CreateAgentClient(_factory, mineMachine);

        HttpResponseMessage response = await agent.GetAsync("/api/agent/actions");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        List<AgentActionDispatch>? dispatches = await response.ReadAsync<List<AgentActionDispatch>>();

        Assert.NotNull(dispatches);
        Assert.Single(dispatches!);
        Assert.Equal(mineAction, dispatches![0].ActionRequestId);
        Assert.Equal("Spooler", dispatches[0].Parameters["serviceName"]);

        ActionRequest collected = await _factory.WithDbAsync(db =>
            db.ActionRequests.AsNoTracking().FirstAsync(a => a.Id == mineAction));
        ActionRequest untouched = await _factory.WithDbAsync(db =>
            db.ActionRequests.AsNoTracking().FirstAsync(a => a.Id == theirsAction));

        Assert.Equal(ActionRequestStatus.Dispatched, collected.Status);
        Assert.NotNull(collected.DispatchedUtc);
        Assert.Equal(ActionRequestStatus.Approved, untouched.Status);

        // A second poll must not hand the same action over again.
        List<AgentActionDispatch>? second =
            await (await agent.GetAsync("/api/agent/actions")).ReadAsync<List<AgentActionDispatch>>();

        Assert.Empty(second!);
    }

    private static async Task<Guid> ApprovedActionAsync(
        HttpClient requester, HttpClient approver, Guid cabinetId)
    {
        HttpResponseMessage created = await requester.PostJsonAsync(
            "/api/actions",
            new Contracts.Actions.CreateActionRequest
            {
                Action = ActionName.StopService,
                CabinetId = cabinetId,
                Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
                Reason = "Service is hung."
            });

        Contracts.Actions.ActionRequestDto? dto =
            await created.ReadAsync<Contracts.Actions.ActionRequestDto>();

        HttpResponseMessage approved = await approver.PostJsonAsync(
            $"/api/actions/{dto!.Id}/approve", new Contracts.Actions.ApproveActionRequest());

        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);

        return dto.Id;
    }

    private static CheckInRequest SampleCheckIn(string machineId) => new()
    {
        MachineId = machineId,
        CollectedAtUtc = new DateTime(2026, 3, 1, 12, 0, 0, DateTimeKind.Utc),
        Hostname = "CLINIC-PC-01",
        AgentVersion = "1.4.2",
        OsVersion = "Windows 11 23H2",
        CpuPercent = 22.5,
        RamUsedPercent = 61.2,
        RamTotalBytes = 17_179_869_184,
        AnyUserLoggedOn = true,
        Volumes =
        {
            new VolumeSnapshot { VolumeId = "C:", TotalBytes = 1000, FreeBytes = 400 },
            new VolumeSnapshot { VolumeId = "D:", TotalBytes = 1000, FreeBytes = 80 }
        },
        PendingUpdates =
        {
            new PendingUpdateSnapshot { UpdateId = "KB1", Title = "Security update", IsSecurityUpdate = true },
            new PendingUpdateSnapshot { UpdateId = "KB2", Title = "Driver update" }
        },
        SmartReadings =
        {
            new SmartSnapshot
            {
                DriveSerial = "DRIVE-SERIAL-1",
                DriveModel = "Contoso SSD 500G",
                TimestampUtc = new DateTime(2026, 3, 1, 12, 0, 0, DateTimeKind.Utc),
                PredictedHealth = DiskHealthStatus.Warning,
                ReallocatedSectorCount = 12,
                PowerOnHours = 14_500,
                TemperatureCelsius = 41
            }
        }
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
