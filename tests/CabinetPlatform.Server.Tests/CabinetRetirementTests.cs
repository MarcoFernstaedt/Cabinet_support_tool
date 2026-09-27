using System.Net;
using CabinetPlatform.Contracts.Auth;
using Microsoft.EntityFrameworkCore;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Services;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetRetirementTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public CabinetRetirementTests(SupportApiFactory factory) => _factory = factory;

    [Theory]
    [InlineData(Role.Tier1)]
    [InlineData(Role.Tier2)]
    public async Task Support_cannot_retire_and_denial_is_audited(Role role)
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, role, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostJsonAsync($"/api/cabinets/{cabinet.Id}/retire", new { Reason = "Denied retirement" })).StatusCode);
        await _factory.WithDbAsync(async db =>
        {
            Assert.True((await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id)).IsActive);
            Assert.Contains(await db.AuditEntries.Where(a => a.ActorId == user.Id.ToString()).ToListAsync(),
                a => a.Event == AuditEvent.AuthorizationDenied && a.Result == AuditResult.Denied);
        });
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public async Task Retirement_requires_reason(string? reason)
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostJsonAsync($"/api/cabinets/{cabinet.Id}/retire", new { Reason = reason })).StatusCode);
        Assert.True(await _factory.WithDbAsync(db => db.Cabinets.Where(c => c.Id == cabinet.Id).Select(c => c.IsActive).SingleAsync()));
    }

    [Fact]
    public async Task Retirement_excludes_active_aggregates_but_keeps_history_accessible()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        string site = Guid.NewGuid().ToString();
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site, role: CabinetRole.Sync);
        var peer = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        var agent = TestClient.CreateAgentClient(_factory, cabinet.MachineId);
        Assert.Equal(HttpStatusCode.OK, (await agent.PostJsonAsync("/api/agent/checkin/full", Payload(cabinet))).StatusCode);
        var before = await _factory.WithDbAsync(async db => new
        {
            Heartbeats = await db.Heartbeats.Where(h => h.CabinetId == cabinet.Id).Select(h => h.Id).ToArrayAsync(),
            Inventory = await db.InventoryVersions.Where(h => h.CabinetId == cabinet.Id).Select(h => h.Id).ToArrayAsync(),
            Audit = await db.AuditEntries.Where(a => a.CabinetId == cabinet.Id).Select(a => a.Id).ToArrayAsync()
        });
        Assert.NotEmpty(before.Heartbeats);
        await Retire(client, cabinet);
        var health = (await (await client.GetAsync($"/api/fleet/health?siteId={cabinet.SiteId}")).ReadAsync<FleetHealthSummary>())!;
        Assert.Equal(1, health.TotalCabinets);
        Assert.Equal(1, health.Healthy + health.Warning + health.Critical + health.Offline + health.Unknown);
        Assert.Equal(1, health.AgentVersions.Sum(v => v.CabinetCount));
        var detail = (await (await client.GetAsync($"/api/fleet/sites/{cabinet.SiteId}")).ReadAsync<SiteDetailDto>())!;
        Assert.Equal(peer.Id, Assert.Single(detail.Cabinets).Id);
        Assert.Equal(1, detail.Site.CabinetCount);
        Assert.Null(detail.Site.SyncCabinetId);
        var sites = (await (await client.GetAsync($"/api/fleet/sites?search={site}")).ReadAsync<PagedResult<SiteSummary>>())!;
        Assert.Equal(1, Assert.Single(sites.Items).CabinetCount);
        var active = (await (await client.GetAsync($"/api/cabinets?siteId={cabinet.SiteId}&isActive=true")).ReadAsync<PagedResult<CabinetSummary>>())!;
        Assert.Equal(peer.Id, Assert.Single(active.Items).Id);
        var retired = (await (await client.GetAsync($"/api/cabinets?siteId={cabinet.SiteId}&isActive=false")).ReadAsync<PagedResult<CabinetSummary>>())!;
        Assert.Equal(cabinet.Id, Assert.Single(retired.Items).Id);
        var historical = (await (await client.GetAsync($"/api/cabinets/{cabinet.Id}")).ReadAsync<CabinetDetailDto>())!;
        Assert.False(historical.Cabinet.IsActive);
        Assert.NotNull(historical.LatestHeartbeat);
        Assert.Equal(1, historical.Site.CabinetCount);
        await _factory.WithDbAsync(async db =>
        {
            Assert.Equal(before.Heartbeats, await db.Heartbeats.Where(h => h.CabinetId == cabinet.Id).Select(h => h.Id).ToArrayAsync());
            Assert.Equal(before.Inventory, await db.InventoryVersions.Where(h => h.CabinetId == cabinet.Id).Select(h => h.Id).ToArrayAsync());
            foreach (var id in before.Audit) Assert.True(await db.AuditEntries.AnyAsync(a => a.Id == id));
            Assert.Equal(cabinet.ApprovedByUserId, (await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id)).ApprovedByUserId);
        });
    }

    [Fact]
    public async Task Retired_device_cannot_register_monitor_collect_or_report_and_new_actions_are_refused()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var agent = TestClient.CreateAgentClient(_factory, cabinet.MachineId);
        var queued = await SeedAction(cabinet, user.Id);
        await Retire(client, cabinet);
        var registration = await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        {
            MachineId = cabinet.MachineId, Hostname = cabinet.Hostname, OsVersion = "test", AgentVersion = "test"
        });
        Assert.Equal(RegistrationStatus.Rejected, (await registration.ReadAsync<RegistrationResponse>())!.Status);
        foreach (string path in new[] { "/api/agent/checkin", "/api/agent/checkin/full" })
            Assert.Equal(HttpStatusCode.Forbidden, (await agent.PostJsonAsync(path, Payload(cabinet))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.GetAsync("/api/agent/actions")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.GetAsync("/api/agent/connectivity/plan")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.PostJsonAsync("/api/agent/connectivity/summaries", Array.Empty<ConnectivitySummary>())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.PostJsonAsync("/api/agent/actions/result", new ActionResultDto
        {
            RequestId = queued.Id, Status = ActionStatus.Succeeded,
            StartedAtUtc = DateTimeOffset.UtcNow, CompletedAtUtc = DateTimeOffset.UtcNow
        })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostJsonAsync("/api/actions", new
        {
            CabinetId = cabinet.Id, Action = ActionName.GetProcessList, Reason = "Should not run"
        })).StatusCode);
        await _factory.WithDbAsync(async db =>
        {
            Assert.Empty(await db.Heartbeats.Where(h => h.CabinetId == cabinet.Id).ToListAsync());
            var action = await db.ActionRequests.SingleAsync(a => a.Id == queued.Id);
            Assert.Equal(ActionRequestStatus.Approved, action.Status);
            Assert.Null(action.DispatchedUtc);
            Assert.Null(action.ResultStatus);
        });
    }

    [Fact]
    public async Task Stale_ingestion_context_must_recheck_retirement_under_its_write_lock()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
        var stale = await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id);
        await Retire(client, cabinet);
        var ingest = scope.ServiceProvider.GetRequiredService<ICheckInIngestService>();
        var result = await ingest.IngestAsync(stale, CheckInTier.Heartbeat, Payload(cabinet), default);
        Assert.False(result.Succeeded);
        Assert.Equal(OperationFailure.Forbidden, result.Failure);
        await _factory.WithDbAsync(async fresh =>
        {
            Assert.Empty(await fresh.Heartbeats.Where(h => h.CabinetId == cabinet.Id).ToListAsync());
            Assert.Null((await fresh.Cabinets.SingleAsync(c => c.Id == cabinet.Id)).LastCheckInUtc);
        });
    }

    [Fact]
    public async Task Queued_peer_probe_to_retired_target_is_cancelled_and_following_observation_dispatches()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var source = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var target = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var probe = await SeedAction(source, user.Id, target.Id);
        var observation = await SeedAction(source, user.Id);
        await Retire(client, target);
        var agent = TestClient.CreateAgentClient(_factory, source.MachineId);
        var response = await agent.GetAsync("/api/agent/actions");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var actions = (await response.ReadAsync<ActionRequestDto[]>())!;
        Assert.Equal(observation.Id, Assert.Single(actions).Id);
        await _factory.WithDbAsync(async db =>
        {
            Assert.Equal(ActionRequestStatus.Cancelled, (await db.ActionRequests.SingleAsync(a => a.Id == probe.Id)).Status);
            Assert.Contains(await db.AuditEntries.Where(a => a.CabinetId == source.Id).ToListAsync(),
                a => a.Event == AuditEvent.AgentCollectActions && a.Result == AuditResult.Denied);
        });
    }

    [Fact]
    public async Task Stale_dispatch_context_cannot_deliver_queued_work_after_retirement()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var queued = await SeedAction(cabinet, user.Id);
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
        _ = await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id);
        await Retire(client, cabinet);
        var controller = ActivatorUtilities.CreateInstance<CabinetPlatform.Server.Controllers.AgentController>(scope.ServiceProvider);
        controller.ControllerContext = new Microsoft.AspNetCore.Mvc.ControllerContext
        {
            HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext
            {
                RequestServices = scope.ServiceProvider,
                User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
                    new[] { new System.Security.Claims.Claim(CabinetPlatform.Server.Security.AgentAuthenticationHandler.MachineIdClaimType, cabinet.MachineId) }, "test"))
            }
        };
        var result = await controller.CollectActions(default);
        var refusal = Assert.IsType<Microsoft.AspNetCore.Mvc.ObjectResult>(result.Result);
        Assert.Equal(403, refusal.StatusCode);
        Assert.Null(await _factory.WithDbAsync(fresh => fresh.ActionRequests.Where(a => a.Id == queued.Id).Select(a => a.DispatchedUtc).SingleAsync()));
    }

    [Fact]
    public async Task Concurrent_retirement_retries_write_one_success_audit()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Retire(client, cabinet)));
        var audits = await _factory.WithDbAsync(db => db.AuditEntries.Where(a => a.CabinetId == cabinet.Id).ToListAsync());
        Assert.Single(audits, a => a.Event.ToString() == "RetireCabinet");
    }

    private Task<ActionRequest> SeedAction(Cabinet cabinet, Guid userId, Guid? target = null) =>
        _factory.WithDbAsync(async db =>
        {
            var action = new ActionRequest
            {
                CabinetId = cabinet.Id, RequestedByUserId = userId,
                Action = target is null ? ActionName.GetProcessList : ActionName.PingCabinet,
                TargetCabinetId = target, Status = ActionRequestStatus.Approved,
                Reason = "Historical queued synthetic work", RequestedUtc = DateTimeOffset.UtcNow,
                ExpiresUtc = DateTimeOffset.UtcNow.AddHours(1), ParametersJson = "{}"
            };
            db.ActionRequests.Add(action);
            await db.SaveChangesAsync();
            return action;
        });

    private static CheckInPayload Payload(Cabinet cabinet) => new()
    {
        MachineId = cabinet.MachineId,
        AgentVersion = "retirement-test", CollectedAtUtc = DateTimeOffset.UtcNow.AddSeconds(-1)
    };

    private static async Task Retire(HttpClient client, Cabinet cabinet) =>
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{cabinet.Id}/retire", new { Reason = "Retire synthetic fixture" })).StatusCode);

    [Fact]
    public async Task Supervisor_retires_once_with_named_audit_and_preserved_identity()
    {
        var (supervisor, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        for (int attempt = 0; attempt < 2; attempt++)
            Assert.Equal(HttpStatusCode.NoContent, (await supervisor.PostJsonAsync($"/api/cabinets/{cabinet.Id}/retire", new { Reason = "Retire synthetic fixture" })).StatusCode);
        await _factory.WithDbAsync(async db =>
        {
            var saved = await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id);
            Assert.False(saved.IsActive);
            Assert.Equal(cabinet.MachineId, saved.MachineId);
            Assert.Equal(cabinet.SiteId, saved.SiteId);
            var entries = await db.AuditEntries.Where(a => a.CabinetId == cabinet.Id && a.Reason == "Retire synthetic fixture").ToListAsync();
            var entry = Assert.Single(entries);
            Assert.Equal("RetireCabinet", entry.Event.ToString());
            Assert.Equal(user.Id.ToString(), entry.ActorId);
        });
        Assert.Equal(HttpStatusCode.OK, (await supervisor.GetAsync($"/api/cabinets/{cabinet.Id}")).StatusCode);
    }
}
