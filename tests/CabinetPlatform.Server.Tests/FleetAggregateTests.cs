using System.Net;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The fleet aggregates, and the columns they are built from.
/// </summary>
/// <remarks>
/// The constraint that shapes all of this is scale. Seven thousand cabinets
/// means the dashboard reads extracted columns or it does not work: a query
/// that opened seven thousand stored inventory documents to count security
/// updates would arrive as a timeout on a support call rather than as a design
/// review.
/// </remarks>
public sealed class FleetAggregateTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public FleetAggregateTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task An_inventory_check_in_extracts_the_two_counts_the_dashboard_reads()
    {
        // Security updates and stopped auto-start services live in the stored
        // inventory document. They are pulled onto the cabinet row at ingest so
        // the fleet query never has to open one.
        (_, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("extract"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: $"Extract Client {Unique("c")}");

        HttpClient agent = TestClient.CreateAgentClient(_factory, cabinet.MachineId);

        HttpResponseMessage response =
            await agent.PostJsonAsync("/api/agent/checkin/full", PayloadWith(cabinet));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Cabinet stored = await _factory.WithDbAsync(db => db.Cabinets
            .AsNoTracking()
            .FirstAsync(c => c.Id == cabinet.Id));

        // Two of the three pending updates are security fixes: one classified
        // as such, one a rollup flagged IsSecurity. The classification and the
        // flag are separate because a security fix can ship inside a rollup.
        Assert.Equal(2, stored.PendingSecurityUpdateCount);

        // One automatic and one automatic-delayed service are stopped. Both
        // count: a delayed-start service stopped long after boot is as broken
        // as an ordinary one.
        Assert.Equal(2, stored.AutoStartServicesStoppedCount);
    }

    [Fact]
    public async Task A_heartbeat_does_not_overwrite_a_known_count_with_nothing()
    {
        // A heartbeat carries neither section. Blanking the counts every five
        // minutes would make the fleet view flicker between the truth and
        // nothing, which is worse than a slightly stale number.
        (_, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("keep"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: $"Keep Client {Unique("c")}");

        HttpClient agent = TestClient.CreateAgentClient(_factory, cabinet.MachineId);

        await agent.PostJsonAsync("/api/agent/checkin/full", PayloadWith(cabinet));

        await agent.PostJsonAsync("/api/agent/checkin", new CheckInPayload
        {
            AgentVersion = "1.0.0",
            MachineId = cabinet.MachineId,
            CabinetId = cabinet.Id,
            CollectedAtUtc = DateTimeOffset.UtcNow,
        });

        Cabinet stored = await _factory.WithDbAsync(db => db.Cabinets
            .AsNoTracking()
            .FirstAsync(c => c.Id == cabinet.Id));

        Assert.Equal(2, stored.PendingSecurityUpdateCount);
        Assert.Equal(2, stored.AutoStartServicesStoppedCount);
    }

    [Fact]
    public async Task The_fleet_summary_counts_what_a_rep_acts_on_first()
    {
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("fleet"));

        string clientName = $"Fleet Client {Unique("f")}";

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: clientName);

        HttpClient agent = TestClient.CreateAgentClient(_factory, cabinet.MachineId);
        await agent.PostJsonAsync("/api/agent/checkin/full", PayloadWith(cabinet));

        FleetHealthSummary? summary =
            await (await client.GetAsync($"/api/fleet/health?clientName={Uri.EscapeDataString(clientName)}"))
                .ReadAsync<FleetHealthSummary>();

        Assert.NotNull(summary);
        Assert.Equal(1, summary!.TotalCabinets);

        Assert.Equal(1, summary.WithPendingUpdates);
        Assert.Equal(1, summary.WithPendingSecurityUpdates);
        Assert.Equal(1, summary.WithAutoStartServicesStopped);
        Assert.Equal(1, summary.RebootPending);

        // Disk health is counted per cabinet by the worst drive in it, which is
        // the number that decides whether anybody drives out with a spare.
        Assert.Equal(1, summary.Disks.Watch);

        // And the agent version distribution, because a fleet running four
        // versions is a fleet where a bug report means four different things.
        AgentVersionCount version = Assert.Single(summary.AgentVersions);
        Assert.Equal("1.0.0", version.Version);
        Assert.Equal(1, version.CabinetCount);
    }

    [Fact]
    public async Task Stale_is_a_question_about_the_telemetry_rather_than_a_verdict_on_the_cabinet()
    {
        // Offline is a health verdict and shows up as a red row. Stale asks
        // whether the telemetry is arriving at all, over a much wider window,
        // and the two numbers diverging is itself the signal.
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("stale"));

        string clientName = $"Stale Client {Unique("s")}";

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: clientName);

        HttpClient agent = TestClient.CreateAgentClient(_factory, cabinet.MachineId);
        await agent.PostJsonAsync("/api/agent/checkin/full", PayloadWith(cabinet));

        string url = $"/api/fleet/health?clientName={Uri.EscapeDataString(clientName)}";

        // Just checked in, so nothing is stale at the default window.
        FleetHealthSummary? fresh = await (await client.GetAsync(url)).ReadAsync<FleetHealthSummary>();
        Assert.NotNull(fresh);
        Assert.Equal(0, fresh!.Stale);

        // A one-hour window over a cabinet that checked in a moment ago is
        // still not stale; a window the caller sets is honoured and echoed back
        // so the number on screen says what it means.
        FleetHealthSummary? narrow =
            await (await client.GetAsync(url + "&staleAfterHours=1")).ReadAsync<FleetHealthSummary>();

        Assert.NotNull(narrow);
        Assert.Equal(1, narrow!.StaleAfterHours);
        Assert.Equal(0, narrow.Stale);

        // Age the check-in past that window and the count moves, while the
        // health verdict is a separate question answered separately.
        await _factory.WithDbAsync(async db =>
        {
            Cabinet stored = await db.Cabinets.FirstAsync(c => c.Id == cabinet.Id);
            stored.LastCheckInUtc = DateTimeOffset.UtcNow.AddHours(-4);
            await db.SaveChangesAsync();
            return stored;
        });

        FleetHealthSummary? aged =
            await (await client.GetAsync(url + "&staleAfterHours=1")).ReadAsync<FleetHealthSummary>();

        Assert.NotNull(aged);
        Assert.Equal(1, aged!.Stale);
    }

    [Fact]
    public async Task A_site_reports_how_its_satellites_last_found_its_sync_cabinet()
    {
        // A sync cabinet problem does not present as a sync cabinet problem: it
        // presents as every cabinet at the site behaving oddly. Reachable from
        // the server is a different fact and is never substituted for this one.
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("sync"));

        string clientName = $"Sync Client {Unique("y")}";

        Cabinet sync = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("sync"), user.Id,
            clientName: clientName, siteName: "One Site", role: CabinetRole.Sync);

        Cabinet reaching = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("sat1"), user.Id,
            clientName: clientName, siteName: "One Site", role: CabinetRole.Satellite);

        Cabinet notReaching = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("sat2"), user.Id,
            clientName: clientName, siteName: "One Site", role: CabinetRole.Satellite);

        // A third satellite that has never probed, counted separately: not
        // knowing is not the same as reaching, and not the same as failing.
        await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("sat3"), user.Id,
            clientName: clientName, siteName: "One Site", role: CabinetRole.Satellite);

        await _factory.WithDbAsync(async db =>
        {
            db.CabinetLinkProbes.AddRange(
                new CabinetLinkProbe
                {
                    SourceCabinetId = reaching.Id,
                    TargetCabinetId = sync.Id,
                    ObservedUtc = DateTimeOffset.UtcNow.AddMinutes(-5),
                    Reachable = true,
                    LatencyMs = 2.1,
                },
                new CabinetLinkProbe
                {
                    SourceCabinetId = notReaching.Id,
                    TargetCabinetId = sync.Id,
                    ObservedUtc = DateTimeOffset.UtcNow.AddMinutes(-4),
                    Reachable = false,
                });

            await db.SaveChangesAsync();
            return 0;
        });

        SiteDetailDto? detail =
            await (await client.GetAsync($"/api/fleet/sites/{sync.SiteId}")).ReadAsync<SiteDetailDto>();

        Assert.NotNull(detail);
        Assert.NotNull(detail!.Site.SyncReachability);

        Assert.Equal(1, detail.Site.SyncReachability!.Reaching);
        Assert.Equal(1, detail.Site.SyncReachability.NotReaching);
        Assert.Equal(1, detail.Site.SyncReachability.NeverProbed);

        // The sync cabinet leads the list, and the paths ride alongside so no
        // console has to assemble an identification of its own.
        Assert.Equal(sync.Id, detail.Cabinets[0].Id);
        Assert.Equal(sync.Id, detail.CabinetPaths[0].CabinetId);
        Assert.Equal(4, detail.CabinetPaths.Count);

        // Null until somebody actually probes. The satellite that has not is
        // reported as unknown rather than as reaching.
        SatelliteLinkDto never = detail.SatelliteLinks.Single(l =>
            l.CabinetId != reaching.Id && l.CabinetId != notReaching.Id);

        Assert.Null(never.Reachable);
    }

    [Fact]
    public async Task A_standalone_site_reports_no_sync_reachability_rather_than_an_empty_one()
    {
        // A site with no sync cabinet has no such relationship to report, and
        // must not be shown zeroes that read as "nothing can reach it".
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("alone"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id,
            clientName: $"Standalone Client {Unique("a")}",
            siteName: "Only Site",
            role: CabinetRole.Standalone);

        SiteDetailDto? detail =
            await (await client.GetAsync($"/api/fleet/sites/{cabinet.SiteId}")).ReadAsync<SiteDetailDto>();

        Assert.NotNull(detail);
        Assert.Null(detail!.Site.SyncReachability);
    }

#if LEGACY_MAINTENANCE_TESTS
    [Fact]
    public async Task An_install_outcome_reported_on_a_check_in_is_audited_as_caused()
    {
        // Scheduling an install and installing one are different facts. A fleet
        // that records only the first believes it is patched the moment a
        // request is dispatched.
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("outcome"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: $"Outcome Client {Unique("o")}");

        HttpResponseMessage created = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.ScanForUpdates,
            CabinetId = cabinet.Id,
            Reason = "Routine patch review before the outcome is reported.",
            TicketReference = "SUP-7000",
        });

        ActionRequestView? action = await created.ReadAsync<ActionRequestView>();
        Assert.NotNull(action);

        HttpClient agent = TestClient.CreateAgentClient(_factory, cabinet.MachineId);

        HttpResponseMessage checkIn = await agent.PostJsonAsync("/api/agent/checkin", new CheckInPayload
        {
            AgentVersion = "1.0.0",
            MachineId = cabinet.MachineId,
            CabinetId = cabinet.Id,
            CollectedAtUtc = DateTimeOffset.UtcNow,
            UpdateInstallOutcomes = new[]
            {
                new UpdateInstallOutcome
                {
                    ActionRequestId = action!.Id,
                    CompletedUtc = DateTimeOffset.UtcNow.AddMinutes(-2),
                    RebootRequired = true,
                    Results = new[]
                    {
                        new UpdateInstallResult
                        {
                            UpdateId = "c1b2a3d4-5e6f-4071-8293-a4b5c6d7e8f9",
                            Title = "2026-09 Cumulative Update",
                            ResultCode = UpdateResultCode.Failed,
                            ErrorCode = unchecked((int)0x80240022),
                        },
                    },
                },
            },
        });

        Assert.Equal(HttpStatusCode.OK, checkIn.StatusCode);

        Domain.AuditEntry entry = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.UpdateInstallOutcome && a.CabinetId == cabinet.Id)
            .FirstAsync());

        // Caused, because the platform asked for the install even though
        // Windows performed it. And a failure, because the install failed —
        // reporting it as a success would be the whole problem.
        Assert.Equal(AuditEventKind.Caused, entry.EventKind);
        Assert.Equal(AuditResult.Failure, entry.Result);
        Assert.Equal(ActionName.ScanForUpdates, entry.Action);

        // The outcome lands on the request that caused it, so a rep reading the
        // action sees what it did rather than only that it was sent.
        string? collected = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking()
            .Where(a => a.Id == action.Id)
            .Select(a => a.CollectedDataJson)
            .FirstAsync());

        Assert.NotNull(collected);

        // The Windows error code travels with it, because "it failed" and "it
        // failed with 0x80240022, which means the update is no longer
        // available" lead to different next steps.
        Assert.Contains(
            unchecked((int)0x80240022).ToString(), collected!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_outcome_naming_another_cabinets_action_is_discarded()
    {
        // An agent cannot report on somebody else's work. Storing it against
        // whatever it happened to match would put one cabinet's patch history
        // on another's record.
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("crossout"));

        string clientName = $"Cross Client {Unique("x")}";

        Cabinet first = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m1"), user.Id, clientName: clientName);

        Cabinet second = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m2"), user.Id, clientName: clientName);

        ActionRequestView? action =
            await (await client.PostJsonAsync("/api/actions", new CreateActionRequest
            {
                Action = ActionName.ScanForUpdates,
                CabinetId = first.Id,
                Reason = "An action belonging to the first cabinet.",
                TicketReference = "SUP-7001",
            })).ReadAsync<ActionRequestView>();

        Assert.NotNull(action);

        HttpClient agent = TestClient.CreateAgentClient(_factory, second.MachineId);

        await agent.PostJsonAsync("/api/agent/checkin", new CheckInPayload
        {
            AgentVersion = "1.0.0",
            MachineId = second.MachineId,
            CabinetId = second.Id,
            CollectedAtUtc = DateTimeOffset.UtcNow,
            UpdateInstallOutcomes = new[]
            {
                new UpdateInstallOutcome
                {
                    ActionRequestId = action!.Id,
                    CompletedUtc = DateTimeOffset.UtcNow,
                    Results = Array.Empty<UpdateInstallResult>(),
                },
            },
        });

        string? collected = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking()
            .Where(a => a.Id == action.Id)
            .Select(a => a.CollectedDataJson)
            .FirstAsync());

        Assert.Null(collected);
    }
#endif

    /// <summary>
    /// A full check-in carrying the sections the extracted columns come from.
    /// </summary>
    private static CheckInPayload PayloadWith(Cabinet cabinet) => new()
    {
        AgentVersion = "1.0.0",
        MachineId = cabinet.MachineId,
        CabinetId = cabinet.Id,
        CollectedAtUtc = DateTimeOffset.UtcNow,

        WindowsUpdate = new WindowsUpdateInfo
        {
            PendingUpdateCount = 3,
            RebootPending = true,
            PendingUpdates = new[]
            {
                new PendingUpdateInfo
                {
                    UpdateId = "c1b2a3d4-5e6f-4071-8293-a4b5c6d7e8f9",
                    Title = "Security update",
                    Classification = UpdateClassification.SecurityUpdate,
                },
                new PendingUpdateInfo
                {
                    UpdateId = "d2c3b4a5-6f70-4182-93a4-b5c6d7e8f9a0",
                    Title = "Rollup carrying a security fix",
                    Classification = UpdateClassification.UpdateRollup,
                    IsSecurity = true,
                },
                new PendingUpdateInfo
                {
                    UpdateId = "e3d4c5b6-7081-4293-a4b5-c6d7e8f9a0b1",
                    Title = "Driver",
                    Classification = UpdateClassification.Driver,
                },
            },
        },

        Services = new[]
        {
            new ServiceInfo
            {
                Name = "MashuraDispenseController",
                State = ServiceState.Stopped,
                StartType = ServiceStartType.Automatic,
            },
            new ServiceInfo
            {
                Name = "MashuraSyncService",
                State = ServiceState.Stopped,
                StartType = ServiceStartType.AutomaticDelayed,
            },
            new ServiceInfo
            {
                Name = "Spooler",
                State = ServiceState.Running,
                StartType = ServiceStartType.Automatic,
            },
            new ServiceInfo
            {
                Name = "BITS",
                State = ServiceState.Stopped,
                StartType = ServiceStartType.Manual,
            },
        },

        Disks = new[]
        {
            new DiskInfo
            {
                DriveLetter = "C:",
                Label = "System",
                FileSystem = "NTFS",
                TotalBytes = 512_110_190_592,
                FreeBytes = 120_000_000_000,
                FreePercent = 23.4,
                BitLockerStatus = BitLockerStatus.EncryptedUnlocked,
                HealthStatus = DiskHealthStatus.Watch,
            },
        },
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..20];
}
