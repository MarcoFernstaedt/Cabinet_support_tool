using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Agent.Tests;

public sealed class ConnectivityTransportTests : IClassFixture<DiagnosticConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public ConnectivityTransportTests(DiagnosticConsoleTestHost host) => _host = host;

    private async Task<HttpClient> SupportAsync(Role role = Role.Supervisor)
    {
        var name = $"connectivity-{Guid.NewGuid():N}";
        await _host.CreateUserAsync(role, name);
        var (api, _) = _host.CreateConsole();
        var login = await api.LoginAsync(new LoginRequest { Username = name, Password = ConsoleTestHost.KnownPassword }, default);
        var http = _host.CreateClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", login.AccessToken);
        return http;
    }

    private HttpClient Agent(Cabinet cabinet)
    {
        var http = _host.CreateClient();
        http.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
        http.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", cabinet.MachineId);
        return http;
    }

    [Fact]
    public async Task Supervisor_cannot_configure_new_peer_targets()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("retired-source", site: site);
        var target = await _host.CreateCabinetAsync("retired-target", site: site);
        using var support = await SupportAsync();
        using var response = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "Attempt to re-enable retired probes", targets = new[] { new { cabinetId = target.Id, address = "192.168.50.20" } }
        });
        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
        using var agent = Agent(source);
        var plan = await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions);
        Assert.Empty(plan!.Targets);
    }

    [Fact]
    public async Task Existing_persisted_peer_configuration_is_not_dispatched_to_agent()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("cached-source", site: site);
        var target = await _host.CreateCabinetAsync("cached-target", site: site);
        var previousRevision = Guid.NewGuid();
        using (var scope = _host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
            db.ConnectivityConfigurations.Add(new CabinetPlatform.Server.Domain.ConnectivityConfiguration
            {
                SourceCabinetId = source.Id, SiteId = source.SiteId, ConfigurationId = previousRevision,
                TargetsJson = System.Text.Json.JsonSerializer.Serialize(new[] { new { cabinetId = target.Id, address = "192.168.50.20", isSync = false } }),
                StatesJson = "[]", UpdatedUtc = DateTimeOffset.UtcNow
            });
            await db.SaveChangesAsync();
        }
        using var agent = Agent(source);
        var plan = await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions);
        Assert.Empty(plan!.Targets);
        Assert.Equal(Guid.Empty, plan.ConfigurationId);
        using var support = await SupportAsync();
        using var refused = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "Attempt to replace retained configuration", targets = Array.Empty<object>()
        });
        Assert.Equal(HttpStatusCode.Gone, refused.StatusCode);
        using var scopeAfter = _host.Services.CreateScope();
        var dbAfter = scopeAfter.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
        Assert.Equal(previousRevision, (await dbAfter.ConnectivityConfigurations.FindAsync(source.Id))!.ConfigurationId);
    }

    [Fact]
    public async Task Retired_peer_routes_still_enforce_authentication_and_roles()
    {
        var source = await _host.CreateCabinetAsync("auth-source", site: Guid.NewGuid().ToString());
        using var anonymous = _host.CreateClient();
        using var tier1 = await SupportAsync(Role.Tier1);
        var route = $"/api/connectivity/cabinets/{source.Id}/targets";
        using var anonymousPut = await anonymous.PutAsJsonAsync(route, new { reason = "no", targets = Array.Empty<object>() });
        using var tier1Put = await tier1.PutAsJsonAsync(route, new { reason = "no", targets = Array.Empty<object>() });
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousPut.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, tier1Put.StatusCode);
        using var anonymousPlan = await anonymous.GetAsync("/api/agent/connectivity/plan");
        using var tier1Plan = await tier1.GetAsync("/api/agent/connectivity/plan");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousPlan.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, tier1Plan.StatusCode);
        using var anonymousReport = await anonymous.PostAsJsonAsync("/api/agent/connectivity/summaries", Array.Empty<object>());
        using var tier1Report = await tier1.PostAsJsonAsync("/api/agent/connectivity/summaries", Array.Empty<object>());
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousReport.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, tier1Report.StatusCode);
    }

    [Fact]
    public async Task Retained_configuration_cannot_accept_new_peer_evidence()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("ingest-source", site: site);
        var target = await _host.CreateCabinetAsync("ingest-target", site: site);
        var revision = Guid.NewGuid();
        using (var scope = _host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
            db.ConnectivityConfigurations.Add(new CabinetPlatform.Server.Domain.ConnectivityConfiguration
            {
                SourceCabinetId = source.Id, SiteId = source.SiteId, ConfigurationId = revision,
                TargetsJson = System.Text.Json.JsonSerializer.Serialize(new[] { new { cabinetId = target.Id, address = "192.168.50.20", isSync = false } }),
                StatesJson = "[]", UpdatedUtc = DateTimeOffset.UtcNow
            });
            await db.SaveChangesAsync();
        }
        using var agent = Agent(source);
        using var response = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[]
        {
            FailureSummary(new CabinetPlatform.Contracts.Telemetry.ConnectivityPlan { SourceCabinetId = source.Id, ConfigurationId = revision }, target.Id, DateTimeOffset.UtcNow.AddMinutes(-2))
        });
        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
        using var scopeAfter = _host.Services.CreateScope();
        var dbAfter = scopeAfter.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
        Assert.False(dbAfter.ConnectivityEvidence.Any(e => e.SourceCabinetId == source.Id));
        Assert.Equal("[]", (await dbAfter.ConnectivityConfigurations.FindAsync(source.Id))!.StatesJson);
    }

    [Fact]
    public async Task Legacy_peer_actions_are_refused_on_both_routes_without_creating_requests()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("action-source", site: site);
        var target = await _host.CreateCabinetAsync("action-sync", site: site, role: CabinetRole.Sync);
        using var support = await SupportAsync(Role.Tier1);
        using var direct = await support.PostAsJsonAsync("/api/actions", new
        {
            action = ActionName.PingCabinet, cabinetId = source.Id,
            parameters = new Dictionary<string, string> { ["TargetCabinetId"] = target.Id.ToString() }, reason = "Retired probe"
        });
        Assert.Equal(HttpStatusCode.Gone, direct.StatusCode);
        using var shortcut = await support.PostAsJsonAsync($"/api/actions/cabinets/{source.Id}/test-sync-link", new { reason = "Retired probe" });
        Assert.Equal(HttpStatusCode.Gone, shortcut.StatusCode);
        using var scope = _host.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
        Assert.False(db.ActionRequests.Any(a => a.CabinetId == source.Id && a.Action == ActionName.PingCabinet));
    }

    // Former sampler→HTTP scenario: only retained evidence is projected; no probe is scheduled.
    [Fact]
    public async Task Retained_failure_is_visible_in_console_without_new_sampling()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("historical-source", site: site);
        var target = await _host.CreateCabinetAsync("historical-target", site: site);
        var failure = FailureSummary(new() { SourceCabinetId = source.Id, ConfigurationId = Guid.NewGuid() }, target.Id, DateTimeOffset.UtcNow.AddMinutes(-7));
        await SeedHistory(source, target, new() { TargetCabinetId = target.Id, Condition = "Unreachable", IncidentOpen = true, ObservedUtc = failure.LastObservedUtc }, failure);
        var (api, session) = _host.CreateConsole();
        var username = $"historical-reader-{Guid.NewGuid():N}";
        await _host.CreateUserAsync(Role.Tier1, username);
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var status = await api.GetConnectivityAsync(source.Id, default);
        Assert.Equal(failure, Assert.Single(status.RecentEvidence).Summary);
        Assert.True(Assert.Single(status.Links).IncidentOpen);
        var announcer = new CabinetPlatform.Console.Core.Presentation.RecordingLiveRegionAnnouncer();
        var tab = new CabinetPlatform.Console.Core.ViewModels.MachineTabViewModel(api,
            new CabinetPlatform.Console.Core.Presentation.ActionInvoker(api, ScriptedActionDialog.Accepting("Historical read"), announcer, session),
            session, announcer, new ViewClock { Now = DateTimeOffset.UtcNow });
        await tab.LoadAsync(source.Id);
        Assert.Contains("Unreachable", Assert.Single(tab.ConnectivityRows));
        Assert.Contains("STALE / UNKNOWN", tab.ConnectivityRows[0]);
        Assert.Contains("not application sync", tab.ConnectivityNote);
    }

    // Former configuration validation matrix: every payload is now denied, without rewriting history.
    [Theory]
    [InlineData("self")]
    [InlineData("public")]
    [InlineData("duplicate")]
    [InlineData("missing-reason")]
    [InlineData("empty")]
    public async Task Retired_configuration_refuses_all_payloads_and_preserves_old_revision(string kind)
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("config-source", site: site);
        var target = await _host.CreateCabinetAsync("config-target", site: site);
        var revision = Guid.NewGuid();
        await SeedHistory(source, target, new(), configurationId: revision);
        using var support = await SupportAsync();
        var targets = kind switch
        {
            "empty" => Array.Empty<object>(),
            "duplicate" => new object[] { new { cabinetId = target.Id, address = "192.168.50.20" }, new { cabinetId = target.Id, address = "192.168.50.20" } },
            _ => new object[] { new { cabinetId = kind == "self" ? source.Id : target.Id, address = kind == "public" ? "8.8.8.8" : "192.168.50.20" } }
        };
        using var result = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new { reason = kind == "missing-reason" ? "" : "Retired", targets });
        Assert.Equal(HttpStatusCode.Gone, result.StatusCode);
        using var agent = Agent(source);
        var plan = await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions);
        Assert.Empty(plan!.Targets);
        Assert.Equal(Guid.Empty, plan.ConfigurationId);
        using var scope = _host.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
        Assert.Equal(revision, (await db.ConnectivityConfigurations.FindAsync(source.Id))!.ConfigurationId);
    }

    [Fact]
    public async Task Agent_routes_require_approved_identity_and_support_routes_require_user_authentication()
    {
        using var anonymous = _host.CreateClient();
        using var noAuth = await anonymous.GetAsync("/api/agent/connectivity/plan");
        Assert.Equal(HttpStatusCode.Unauthorized, noAuth.StatusCode);
        var inactive = await _host.CreateCabinetAsync("revoked-connectivity", isActive: false);
        using var agent = Agent(inactive);
        using var denied = await agent.GetAsync("/api/agent/connectivity/plan");
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        using var deniedRead = await agent.GetAsync($"/api/connectivity/cabinets/{inactive.Id}");
        Assert.Equal(HttpStatusCode.Unauthorized, deniedRead.StatusCode);
        using var pending = Agent(new Cabinet { MachineId = "not-approved-" + Guid.NewGuid() });
        using var pendingPlan = await pending.GetAsync("/api/agent/connectivity/plan");
        Assert.Equal(HttpStatusCode.Forbidden, pendingPlan.StatusCode);
    }

    // Former invalid-ingestion matrix: retired endpoint refuses both valid and invalid evidence.
    [Theory]
    [InlineData("valid")]
    [InlineData("wrong-source")]
    [InlineData("wrong-revision")]
    [InlineData("negative-count")]
    public async Task Retired_ingestion_refuses_payload_without_changing_historical_projection(string kind)
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("validation-source", site: site);
        var target = await _host.CreateCabinetAsync("validation-target", site: site);
        var old = FailureSummary(new() { SourceCabinetId = source.Id, ConfigurationId = Guid.NewGuid() }, target.Id, DateTimeOffset.UtcNow.AddMinutes(-9));
        await SeedHistory(source, target, new() { TargetCabinetId = target.Id, Condition = "Unreachable", IncidentOpen = true, ObservedUtc = old.LastObservedUtc }, old);
        var incoming = FailureSummary(new() { SourceCabinetId = source.Id, ConfigurationId = old.ConfigurationId }, target.Id, DateTimeOffset.UtcNow.AddMinutes(-2));
        incoming = kind switch {
            "wrong-source" => incoming with { SourceCabinetId = Guid.NewGuid() },
            "wrong-revision" => incoming with { ConfigurationId = Guid.NewGuid() },
            "negative-count" => incoming with { FailureCount = -1 },
            _ => incoming
        };
        using var agent = Agent(source);
        using var response = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { incoming }, AgentJson.SerializerOptions);
        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
        using var support = await SupportAsync();
        var status = (await support.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}", AgentJson.SerializerOptions))!;
        Assert.Equal(old, Assert.Single(status.RecentEvidence).Summary);
        Assert.True(Assert.Single(status.Links).IncidentOpen);
    }

    // Former lost-ACK replay: existing durable spool survives refused upload; ledger stays unchanged.
    [Fact]
    public async Task Retired_upload_does_not_acknowledge_historical_spooled_summary()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("spool-source", site: site);
        var target = await _host.CreateCabinetAsync("spool-target", site: site);
        var summary = FailureSummary(new() { SourceCabinetId = source.Id, ConfigurationId = Guid.NewGuid() }, target.Id, DateTimeOffset.UtcNow.AddMinutes(-2));
        var directory = Path.Combine(Path.GetTempPath(), $"retired-spool-{Guid.NewGuid():N}");
        try
        {
            var spool = new CabinetPlatform.Agent.Connectivity.ConnectivitySpool(directory);
            Assert.True(spool.Enqueue(summary, DateTimeOffset.UtcNow));
            using var agent = Agent(source);
            var sampler = new CabinetPlatform.Agent.Connectivity.ConnectivitySampler(source.Id,
                new ConnectivitySamplerTests.SequenceProbe(CabinetPlatform.Agent.Connectivity.ProbeObservation.Reply), _ => true);
            var delivery = new CabinetPlatform.Agent.Connectivity.ConnectivityDelivery(agent, spool, sampler);
            Assert.False(await delivery.DeliverAsync(DateTimeOffset.UtcNow, default));
            Assert.Equal(summary, Assert.Single(new CabinetPlatform.Agent.Connectivity.ConnectivitySpool(directory).Peek(DateTimeOffset.UtcNow)));
            using var scope = _host.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
            Assert.False(db.ConnectivityEvidence.Any(e => e.SourceCabinetId == source.Id));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private sealed class ViewClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; }
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private async Task SeedHistory(Cabinet source, Cabinet target, CabinetPlatform.Contracts.Telemetry.ConnectivityLinkState state,
        CabinetPlatform.Contracts.Telemetry.ConnectivitySummary? summary = null, Guid? configurationId = null)
    {
        using var scope = _host.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
        db.ConnectivityConfigurations.Add(new CabinetPlatform.Server.Domain.ConnectivityConfiguration
        {
            SourceCabinetId = source.Id, SiteId = source.SiteId, ConfigurationId = configurationId ?? summary?.ConfigurationId ?? Guid.NewGuid(),
            TargetsJson = System.Text.Json.JsonSerializer.Serialize(new[] { new CabinetPlatform.Contracts.Telemetry.ConnectivityTarget { CabinetId = target.Id, Address = "192.168.50.20" } }, AgentJson.SerializerOptions),
            StatesJson = System.Text.Json.JsonSerializer.Serialize(new[] { state with { TargetCabinetId = target.Id } }, AgentJson.SerializerOptions),
            UpdatedUtc = DateTimeOffset.UtcNow.AddDays(-1)
        });
        if (summary is not null) db.ConnectivityEvidence.Add(new CabinetPlatform.Server.Domain.ConnectivityEvidence
        {
            Id = summary.Id, SourceCabinetId = source.Id, TargetCabinetId = target.Id, ConfigurationId = summary.ConfigurationId,
            FirstObservedUtc = summary.FirstObservedUtc, ObservedUtc = summary.LastObservedUtc,
            ReceivedUtc = summary.LastObservedUtc.AddMinutes(1),
            SummaryJson = System.Text.Json.JsonSerializer.Serialize(summary, AgentJson.SerializerOptions)
        });
        await db.SaveChangesAsync();
    }

    private static CabinetPlatform.Contracts.Telemetry.ConnectivitySummary FailureSummary(
        CabinetPlatform.Contracts.Telemetry.ConnectivityPlan plan, Guid target, DateTimeOffset last) => new()
    {
        Id = Guid.NewGuid(), ConfigurationId = plan.ConfigurationId, SourceCabinetId = plan.SourceCabinetId, TargetCabinetId = target,
        FirstObservedUtc = last.AddMinutes(-2), LastObservedUtc = last, FailureCount = 3, LeadingFailures = 3,
        TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = last
    };

    // Former topology test: historical projection drops moved targets, while plan remains empty.
    [Fact]
    public async Task Moved_historical_target_disappears_from_projection_and_is_not_dispatched()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("topology-source", site: site);
        var target = await _host.CreateCabinetAsync("topology-target", site: site);
        await SeedHistory(source, target, new() { Condition = "Unreachable", IncidentOpen = true });
        var other = await _host.CreateCabinetAsync("different-site", site: site + "different");
        using (var scope = _host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>();
            (await db.Cabinets.FindAsync(target.Id))!.SiteId = other.SiteId;
            await db.SaveChangesAsync();
        }
        using var agent = Agent(source);
        var plan = await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions);
        Assert.Empty(plan!.Targets);
        using var support = await SupportAsync();
        var status = (await support.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}", AgentJson.SerializerOptions))!;
        Assert.Empty(status.Links);
    }

    // Former incident chronology: persisted recovery and failure are displayed, not ingested.
    [Fact]
    public async Task Historical_recovery_is_read_back_without_reopening_on_refused_replay()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("incident-source", site: site);
        var target = await _host.CreateCabinetAsync("incident-target", site: site);
        var failure = FailureSummary(new() { SourceCabinetId = source.Id, ConfigurationId = Guid.NewGuid() }, target.Id, DateTimeOffset.UtcNow.AddMinutes(-8));
        var recovered = failure.LastObservedUtc.AddMinutes(3);
        await SeedHistory(source, target, new() { Condition = "Reachable", IncidentOpen = false,
            ObservedUtc = recovered, RecoveredObservedUtc = recovered }, failure);
        using var agent = Agent(source);
        using var replay = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { failure }, AgentJson.SerializerOptions);
        Assert.Equal(HttpStatusCode.Gone, replay.StatusCode);
        using var support = await SupportAsync();
        var status = (await support.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}", AgentJson.SerializerOptions))!;
        Assert.Equal("Reachable", Assert.Single(status.Links).Condition);
        Assert.False(status.Links[0].IncidentOpen);
        Assert.Equal(recovered, status.Links[0].RecoveredObservedUtc);
        Assert.Equal(failure, Assert.Single(status.RecentEvidence).Summary);
    }

    // Former successful plan issuance: bounded metadata stays valid but targets never issue.
    [Fact]
    public async Task Agent_plan_is_bounded_and_empty_even_for_retained_target()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("plan-source", site: site);
        var target = await _host.CreateCabinetAsync("plan-target", site: site);
        await SeedHistory(source, target, new());
        using var agent = Agent(source);
        var plan = (await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
        Assert.Equal(source.Id, plan.SourceCabinetId);
        Assert.Equal(source.SiteId, plan.SiteId);
        Assert.Equal(Guid.Empty, plan.ConfigurationId);
        Assert.Empty(plan.Targets);
        Assert.True(plan.ExpiresUtc > plan.IssuedUtc);
        Assert.True(plan.ExpiresUtc <= plan.IssuedUtc.AddMinutes(10));
    }
}
