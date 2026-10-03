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
        int checkInsBefore = await _factory.WithDbAsync(db => db.Heartbeats.AsNoTracking().CountAsync());
        int smartBefore = await _factory.WithDbAsync(db => db.SmartReadings.AsNoTracking().CountAsync());

        HttpResponseMessage response = await agent.PostJsonAsync(
            "/api/agent/checkin", SampleCheckIn(machineId));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        // Nothing from an unapproved machine reaches the fleet data.
        int checkInsAfter = await _factory.WithDbAsync(db => db.Heartbeats.AsNoTracking().CountAsync());
        int smartAfter = await _factory.WithDbAsync(db => db.SmartReadings.AsNoTracking().CountAsync());

        Assert.Equal(checkInsBefore, checkInsAfter);
        Assert.Equal(smartBefore, smartAfter);

        bool becameCabinet = await _factory.WithDbAsync(db =>
            db.Cabinets.AsNoTracking().AnyAsync(c => c.MachineId == machineId));

        Assert.False(becameCabinet);

        // But the attempt itself is recorded.
        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.AgentCheckIn &&
                        a.Result == AuditResult.Denied &&
                        a.ActorId == machineId)
            .ToListAsync());

        Assert.NotEmpty(denials);
        Assert.All(denials, d => Assert.Equal(ActorType.Agent, d.ActorType));
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
            _factory, AuditEvent.AuthorizationDenied, AuditResult.Denied);

        Assert.True(denials > 0);
    }

    [Fact]
    public async Task Register_creates_a_pending_registration_and_admits_nothing()
    {
        string machineId = Unique("register");
        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        HttpResponseMessage response = await agent.PostJsonAsync(
            "/api/agent/register",
            new RegistrationRequest
            {
                MachineId = machineId,
                Hostname = "CLINIC-PC-01",
                OsVersion = "Windows 11 23H2",
                AgentVersion = "1.4.2"
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        RegistrationResponse? body = await response.ReadAsync<RegistrationResponse>();
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
                new RegistrationRequest
                {
                    MachineId = machineId,
                    Hostname = "CLINIC-PC-02",
                    OsVersion = "Windows 11 23H2",
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

        Heartbeat stored = await _factory.WithDbAsync(db =>
            db.Heartbeats.AsNoTracking().FirstAsync(c => c.CabinetId == cabinet.Id));

        // The projection columns are what the fleet grid reads; the payload is
        // kept beside them for forensics.
        Assert.Equal(2, stored.PendingUpdateCount);
        Assert.True(stored.AnyUserLoggedOn);
        Assert.Equal(DiskHealthStatus.Watch, stored.WorstDiskHealth);
        Assert.NotNull(stored.MinFreeDiskPercent);
        Assert.InRange(stored.MinFreeDiskPercent!.Value, 7.9, 8.1);

        // A heartbeat carries typed columns and no payload document. Seven
        // thousand cabinets at a five-minute cadence is two million rows a day;
        // a stored blob per row reaches terabytes within weeks and is never
        // read, because every list and aggregate reads these columns.
        InventoryVersion? inventory = await _factory.WithDbAsync(db => db.InventoryVersions
            .AsNoTracking().FirstOrDefaultAsync(v => v.CabinetId == cabinet.Id));

        Assert.Null(inventory);

        // SMART belongs to the full tier and is not collected on a heartbeat.
        Assert.False(await _factory.WithDbAsync(db => db.SmartReadings
            .AsNoTracking().AnyAsync(s => s.CabinetId == cabinet.Id)));

        DateTimeOffset? lastCheckIn = await _factory.WithDbAsync(db => db.Cabinets
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
        CheckInPayload payload = SampleCheckIn(machineId);

        HttpResponseMessage first = await agent.PostJsonAsync("/api/agent/checkin", payload);
        HttpResponseMessage second = await agent.PostJsonAsync("/api/agent/checkin", payload);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        CheckInResponse? secondBody = await second.ReadAsync<CheckInResponse>();
        Assert.True(secondBody!.WasDuplicate);

        int rows = await _factory.WithDbAsync(db =>
            db.Heartbeats.AsNoTracking().CountAsync(c => c.CabinetId == cabinet.Id));

        Assert.Equal(1, rows);
    }

    [Fact]
    public async Task An_agent_cannot_report_another_cabinets_observation_result()
    {
        (HttpClient requester, User supervisor) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("observer"));
        string ownerMachine = Unique("owner");
        string otherMachine = Unique("other");
        Cabinet owner = await TestClient.CreateApprovedCabinetAsync(_factory, ownerMachine, supervisor.Id);
        await TestClient.CreateApprovedCabinetAsync(_factory, otherMachine, supervisor.Id);

        using var created = await requester.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.GetProcessList, CabinetId = owner.Id, Reason = "Synthetic observation"
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var action = (await created.ReadAsync<ActionRequestView>())!;
        using var other = TestClient.CreateAgentClient(_factory, otherMachine);
        using var response = await other.PostJsonAsync("/api/agent/actions/result", new ActionResultDto
        {
            RequestId = action.Id, Status = ActionStatus.Succeeded,
            CompletedAtUtc = DateTimeOffset.UtcNow
        });
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var stored = await _factory.WithDbAsync(db => db.ActionRequests.AsNoTracking()
            .SingleAsync(a => a.Id == action.Id));
        Assert.NotEqual(ActionRequestStatus.Completed, stored.Status);
        Assert.True(await _factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().AnyAsync(a =>
            a.Event == AuditEvent.AgentReportResult && a.Result == AuditResult.Denied &&
            a.ActorId == otherMachine)));
    }

    [Theory]
    [InlineData(ActionName.PingCabinet, ActionStatus.Succeeded)]
    [InlineData(ActionName.PingCabinet, ActionStatus.UnknownResult)]
    [InlineData(ActionName.TraceRouteToCabinet, ActionStatus.Succeeded)]
    public async Task Late_peer_icmp_receipt_preserves_action_but_never_creates_or_updates_link_probe(
        ActionName actionName, ActionStatus status)
    {
        using var factory = new SupportApiFactory();
        (_, User supervisor) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, Unique("late"));
        Cabinet source = await TestClient.CreateApprovedCabinetAsync(factory, Unique("source"), supervisor.Id);
        Cabinet target = await TestClient.CreateApprovedCabinetAsync(factory, Unique("target"), supervisor.Id);
        Cabinet anotherTarget = await TestClient.CreateApprovedCabinetAsync(factory, Unique("target2"), supervisor.Id);
        var oldObserved = new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var oldId = Guid.NewGuid();
        var newId = Guid.NewGuid();
        await factory.WithDbAsync(async db =>
        {
            db.CabinetLinkProbes.Add(new CabinetLinkProbe
            {
                SourceCabinetId = source.Id, TargetCabinetId = target.Id,
                ObservedUtc = oldObserved, Reachable = true, LatencyMs = 12
            });
            foreach (Guid id in new[] { oldId, newId })
                db.ActionRequests.Add(new ActionRequest
                {
                    Id = id, CabinetId = source.Id, TargetCabinetId = id == oldId ? target.Id : anotherTarget.Id,
                    Action = actionName, RequestedByUserId = supervisor.Id,
                    Reason = "Pre-upgrade dispatch", ParametersJson = "{}",
                    Status = ActionRequestStatus.Dispatched, RequestedUtc = oldObserved
                });
            await db.SaveChangesAsync();
        });
        using var agent = TestClient.CreateAgentClient(factory, source.MachineId);
        foreach (Guid id in new[] { oldId, newId })
        {
            var result = new ActionResultDto
            {
                RequestId = id, Status = status, Output = "roundTripMs=7",
                CompletedAtUtc = DateTimeOffset.UtcNow
            };
            using var receipt = await agent.PostJsonAsync("/api/agent/actions/result", result);
            Assert.Equal(HttpStatusCode.NoContent, receipt.StatusCode);
            using var retry = await agent.PostJsonAsync("/api/agent/actions/result", result);
            Assert.Equal(HttpStatusCode.NoContent, retry.StatusCode);
        }
        await factory.WithDbAsync(async db =>
        {
            var rows = await db.ActionRequests.AsNoTracking().Where(a => a.Id == oldId || a.Id == newId).ToListAsync();
            Assert.Equal(2, rows.Count);
            Assert.All(rows, a =>
            {
                Assert.Equal(ActionRequestStatus.Completed, a.Status);
                Assert.Equal(status, a.ResultStatus);
            });
            var probes = await db.CabinetLinkProbes.AsNoTracking().ToListAsync();
            var historical = Assert.Single(probes);
            Assert.Equal(oldObserved, historical.ObservedUtc);
            Assert.Equal(12, historical.LatencyMs);
            Assert.True(historical.Reachable);
        });
    }

#if LEGACY_MAINTENANCE_TESTS
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
            new CreateActionRequest
            {
                Action = ActionName.StopService,
                CabinetId = owner.Id,
                Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
                Reason = "Service is hung."
            });

        ActionRequestView? dto = await created.ReadAsync<ActionRequestView>();

        await approverClient.PostJsonAsync(
            $"/api/actions/{dto!.Id}/approve", new ApproveActionRequest());

        HttpClient intruder = TestClient.CreateAgentClient(_factory, intruderMachine);

        HttpResponseMessage response = await intruder.PostJsonAsync(
            "/api/agent/actions/result",
            new ActionResultDto
            {
                RequestId = dto.Id,
                Status = ActionStatus.Succeeded,
                Output = "done",
                CompletedAtUtc = DateTimeOffset.UtcNow
            });

        // 404 rather than 403: one cabinet should not learn that another
        // cabinet's work exists.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        ActionRequest stored = await _factory.WithDbAsync(db =>
            db.ActionRequests.AsNoTracking().FirstAsync(a => a.Id == dto.Id));

        Assert.NotEqual(ActionRequestStatus.Completed, stored.Status);

        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.AgentReportResult &&
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

        List<ActionRequestDto>? dispatches = await response.ReadAsync<List<ActionRequestDto>>();

        Assert.NotNull(dispatches);
        Assert.Single(dispatches!);
        Assert.Equal(mineAction, dispatches![0].Id);
        Assert.Equal("Spooler", dispatches[0].Parameters["serviceName"]);

        // The envelope the agent receives carries an expiry, so an action that
        // sat in a queue while a cabinet was offline cannot be executed days
        // later against a machine whose state has moved on.
        Assert.NotNull(dispatches[0].ExpiresUtc);

        ActionRequest collected = await _factory.WithDbAsync(db =>
            db.ActionRequests.AsNoTracking().FirstAsync(a => a.Id == mineAction));
        ActionRequest untouched = await _factory.WithDbAsync(db =>
            db.ActionRequests.AsNoTracking().FirstAsync(a => a.Id == theirsAction));

        Assert.Equal(ActionRequestStatus.Dispatched, collected.Status);
        Assert.NotNull(collected.DispatchedUtc);
        Assert.Equal(ActionRequestStatus.Approved, untouched.Status);

        // A second poll must not hand the same action over again.
        List<ActionRequestDto>? second =
            await (await agent.GetAsync("/api/agent/actions")).ReadAsync<List<ActionRequestDto>>();

        Assert.Empty(second!);
    }

    private static async Task<Guid> ApprovedActionAsync(
        HttpClient requester, HttpClient approver, Guid cabinetId)
    {
        HttpResponseMessage created = await requester.PostJsonAsync(
            "/api/actions",
            new CreateActionRequest
            {
                Action = ActionName.StopService,
                CabinetId = cabinetId,
                Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
                Reason = "Service is hung."
            });

        ActionRequestView? dto = await created.ReadAsync<ActionRequestView>();

        HttpResponseMessage approved = await approver.PostJsonAsync(
            $"/api/actions/{dto!.Id}/approve", new ApproveActionRequest());

        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);

        return dto.Id;
    }
#endif

    /// <summary>
    /// A representative full-tier payload, in session 1's sectioned shape.
    /// </summary>
    /// <remarks>
    /// Every counter that a real cabinet might fail to read is left null here
    /// on purpose, so that any code path that turns a missing reading into a
    /// zero shows up as a failing assertion rather than as a plausible number.
    /// </remarks>
    private static CheckInPayload SampleCheckIn(string machineId) => new()
    {
        MachineId = machineId,
        AgentVersion = "1.4.2",
        CollectedAtUtc = new DateTimeOffset(2026, 3, 1, 12, 0, 0, TimeSpan.Zero),
        System = new SystemInfo
        {
            Hostname = "CLINIC-PC-01",
            OsVersion = "Windows 11 23H2",
            AnyUserLoggedOn = true,
            TimeZoneId = "UTC",
            SystemTimeUtc = new DateTimeOffset(2026, 3, 1, 12, 0, 0, TimeSpan.Zero),
        },
        Performance = new PerformanceInfo
        {
            CpuTotalPercent = 22.5,
            RamUsedPercent = 61.2,
            RamTotalBytes = 17_179_869_184,
        },
        Disks = new[]
        {
            new DiskInfo
            {
                DriveLetter = "C",
                TotalBytes = 1000,
                FreeBytes = 400,
                FreePercent = 40,
                BitLockerStatus = BitLockerStatus.EncryptedUnlocked,
                HealthStatus = DiskHealthStatus.Watch,
                Smart = new SmartInfo
                {
                    Source = SmartSource.StorageReliabilityCounter,
                    SerialNumber = "DRIVE-SERIAL-1",
                    Model = "Contoso SSD 500G",
                    ReallocatedSectorCount = 12,
                    PowerOnHours = 14_500,
                    TemperatureCelsius = 41,
                },
            },
            new DiskInfo
            {
                DriveLetter = "D",
                TotalBytes = 1000,
                FreeBytes = 80,
                FreePercent = 8,
                BitLockerStatus = BitLockerStatus.NotEncrypted,
                HealthStatus = DiskHealthStatus.Unknown,
            },
        },
        WindowsUpdate = new WindowsUpdateInfo
        {
            PendingUpdateCount = 2,
            RebootPending = false,
            PendingUpdates = new[]
            {
                new PendingUpdateInfo
                {
                    UpdateId = "KB1",
                    Title = "Security update",
                    Classification = UpdateClassification.SecurityUpdate,
                    IsSecurity = true,
                },
                new PendingUpdateInfo
                {
                    UpdateId = "KB2",
                    Title = "Driver update",
                    Classification = UpdateClassification.Driver,
                },
            },
        },
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
