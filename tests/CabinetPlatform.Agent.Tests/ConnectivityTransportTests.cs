using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Tests;
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

    [Fact(Skip = "Historical peer-ICMP generation scenario; retired configuration cannot schedule new probes")]
    public async Task Real_sampler_durable_outbox_agent_http_and_console_api_show_failure_then_recovery()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("pipeline-source", site: site);
        var target = await _host.CreateCabinetAsync("pipeline-sync", site: site, role: CabinetRole.Sync);
        using var support = await SupportAsync();
        using var configured = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "End to end synthetic observation", targets = new[] { new { cabinetId = target.Id, address = "192.168.50.20" } }
        });
        configured.EnsureSuccessStatusCode();
        using var agent = Agent(source);
        var plan = (await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
        var directory = Path.Combine(Path.GetTempPath(), $"connectivity-e2e-{Guid.NewGuid():N}");
        try
        {
            var spool = new CabinetPlatform.Agent.Connectivity.ConnectivitySpool(directory);
            var clock = DateTimeOffset.UtcNow.AddMinutes(-6);
            var probe = new ConnectivitySamplerTests.SequenceProbe(
                CabinetPlatform.Agent.Connectivity.ProbeObservation.NoReply,
                CabinetPlatform.Agent.Connectivity.ProbeObservation.NoReply,
                CabinetPlatform.Agent.Connectivity.ProbeObservation.NoReply,
                CabinetPlatform.Agent.Connectivity.ProbeObservation.Reply,
                CabinetPlatform.Agent.Connectivity.ProbeObservation.Reply,
                CabinetPlatform.Agent.Connectivity.ProbeObservation.Reply);
            var sampler = new CabinetPlatform.Agent.Connectivity.ConnectivitySampler(source.Id, probe, s => spool.Enqueue(s, DateTimeOffset.UtcNow));
            // Advance only the injected sampling clock. Production obtains these timestamps locally.
            sampler.ApplyPlan(plan with { IssuedUtc = clock, ExpiresUtc = clock.AddMinutes(10) }, clock);
            for (int i = 0; i < 3; i++) await sampler.SampleAsync(clock.AddMinutes(i), default);
            var reopened = new CabinetPlatform.Agent.Connectivity.ConnectivitySpool(directory);
            Assert.Single(reopened.Peek(DateTimeOffset.UtcNow));
            var delivery = new CabinetPlatform.Agent.Connectivity.ConnectivityDelivery(agent, reopened, sampler);
            Assert.True(await delivery.DeliverAsync(DateTimeOffset.UtcNow, default));
            Assert.Empty(reopened.Peek(DateTimeOffset.UtcNow));
            var (api, session) = _host.CreateConsole();
            var username = $"pipeline-reader-{Guid.NewGuid():N}";
            await _host.CreateUserAsync(Role.Tier1, username);
            await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
            var state = await api.GetConnectivityAsync(source.Id, default);
            Assert.True(Assert.Single(state.Links).IncidentOpen);
            Assert.Equal(3, Assert.Single(state.RecentEvidence).Summary.FailureCount);
            var announcer = new CabinetPlatform.Console.Core.Presentation.RecordingLiveRegionAnnouncer();
            var viewClock = new ViewClock { Now = DateTimeOffset.UtcNow };
            var tab = new CabinetPlatform.Console.Core.ViewModels.MachineTabViewModel(api,
                new CabinetPlatform.Console.Core.Presentation.ActionInvoker(api, ScriptedActionDialog.Accepting("Connectivity read"), announcer, session),
                session, announcer, viewClock);
            await tab.LoadAsync(source.Id);
            Assert.Contains("Unreachable", Assert.Single(tab.ConnectivityRows));
            Assert.Contains(target.Id.ToString(), tab.ConnectivityRows[0]);
            Assert.Contains("not application sync", tab.ConnectivityNote);
            for (int i = 3; i < 6; i++) await sampler.SampleAsync(clock.AddMinutes(i), default);
            Assert.True(await delivery.DeliverAsync(DateTimeOffset.UtcNow, default));
            state = await api.GetConnectivityAsync(source.Id, default);
            Assert.False(Assert.Single(state.Links).IncidentOpen);
            Assert.NotNull(state.Links[0].RecoveredObservedUtc);
            Assert.Equal(2, state.RecentEvidence.Count);
            await tab.RefreshCommand.ExecuteAsync(null);
            Assert.Contains("Reachable", Assert.Single(tab.ConnectivityRows));
            Assert.DoesNotContain("STALE", tab.ConnectivityRows[0]);
            viewClock.Now = viewClock.Now.AddMinutes(10);
            tab.RefreshFreshness();
            Assert.Contains("STALE / UNKNOWN", tab.ConnectivityRows[0]);
            await tab.LoadAsync(Guid.NewGuid());
            Assert.Empty(tab.ConnectivityRows);
            Assert.Contains("unknown", tab.ConnectivityNote);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Theory(Skip = "Historical configuration validation superseded by unconditional 410 retirement")]
    [InlineData("other-site", HttpStatusCode.NotFound)]
    [InlineData("other-client", HttpStatusCode.NotFound)]
    [InlineData("inactive", HttpStatusCode.NotFound)]
    [InlineData("self", HttpStatusCode.BadRequest)]
    [InlineData("public", HttpStatusCode.BadRequest)]
    [InlineData("duplicate", HttpStatusCode.BadRequest)]
    [InlineData("too-many", HttpStatusCode.BadRequest)]
    [InlineData("tier1", HttpStatusCode.Forbidden)]
    [InlineData("missing-reason", HttpStatusCode.BadRequest)]
    public async Task Configuration_rejects_unapproved_scope_and_preserves_the_previous_plan(string kind, HttpStatusCode expected)
    {
        string site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("config-source", site: site);
        var target = await _host.CreateCabinetAsync("config-target", site: kind == "other-site" ? site + "other" : site,
            client: kind == "other-client" ? "Other client " + site : "Northgate Veterinary", isActive: kind != "inactive");
        using var support = await SupportAsync(kind == "tier1" ? Role.Tier1 : Role.Supervisor);
        var targets = new[] { new CabinetPlatform.Contracts.Telemetry.ConnectivityTarget
        {
            CabinetId = kind == "self" ? source.Id : target.Id, Address = kind == "public" ? "8.8.8.8" : "192.168.50.20"
        } };
        if (kind is "duplicate" or "too-many") targets = Enumerable.Repeat(targets[0], kind == "duplicate" ? 2 : 5).ToArray();
        using var response = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = kind == "missing-reason" ? "" : "Synthetic denied target", targets
        });
        Assert.Equal(expected, response.StatusCode);
        using var agent = Agent(source);
        var plan = await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions);
        Assert.Empty(plan!.Targets);
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

    [Theory(Skip = "Historical ingestion fixture relied on newly configuring retired peer probes")]
    [InlineData("wrong-source", HttpStatusCode.BadRequest)]
    [InlineData("wrong-target", HttpStatusCode.Conflict)]
    [InlineData("wrong-revision", HttpStatusCode.Conflict)]
    [InlineData("future", HttpStatusCode.BadRequest)]
    [InlineData("expired", HttpStatusCode.BadRequest)]
    [InlineData("negative-count", HttpStatusCode.BadRequest)]
    [InlineData("contradictory-count", HttpStatusCode.BadRequest)]
    [InlineData("short-interval", HttpStatusCode.BadRequest)]
    [InlineData("invented-success-time", HttpStatusCode.BadRequest)]
    public async Task Ingestion_rejects_invalid_evidence_without_persisting_any_state(string kind, HttpStatusCode expected)
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("validation-source", site: site);
        var target = await _host.CreateCabinetAsync("validation-target", site: site);
        using var support = await SupportAsync();
        using var configured = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "Synthetic evidence validation", targets = new[] { new { cabinetId = target.Id, address = "192.168.50.20" } }
        });
        configured.EnsureSuccessStatusCode();
        using var agent = Agent(source);
        var plan = (await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
        var now = DateTimeOffset.UtcNow.AddMinutes(-1);
        var summary = FailureSummary(plan, target.Id, now);
        summary = kind switch
        {
            "wrong-source" => summary with { SourceCabinetId = Guid.NewGuid() },
            "wrong-target" => summary with { TargetCabinetId = Guid.NewGuid() },
            "wrong-revision" => summary with { ConfigurationId = Guid.NewGuid() },
            "future" => summary with { LastObservedUtc = DateTimeOffset.UtcNow.AddMinutes(1) },
            "expired" => summary with { FirstObservedUtc = DateTimeOffset.UtcNow.AddDays(-15) },
            "negative-count" => summary with { FailureCount = -1 },
            "contradictory-count" => summary with { TrailingFailures = 1 },
            "short-interval" => summary with { FirstObservedUtc = now },
            _ => summary with { LastSuccessUtc = now }
        };
        using var report = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { summary }, AgentJson.SerializerOptions);
        Assert.Equal(expected, report.StatusCode);
        var status = (await support.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}", AgentJson.SerializerOptions))!;
        Assert.Empty(status.RecentEvidence);
        Assert.Equal("Unknown", Assert.Single(status.Links).Condition);
    }

    [Fact(Skip = "Historical peer evidence fixture relied on newly configuring retired peer probes")]
    public async Task Lost_http_acknowledgment_replays_real_durable_summary_without_duplicate_incident_or_evidence()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("lost-ack-source", site: site);
        var target = await _host.CreateCabinetAsync("lost-ack-target", site: site);
        using var support = await SupportAsync();
        using var configured = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "Synthetic lost acknowledgment", targets = new[] { new { cabinetId = target.Id, address = "192.168.50.20" } }
        });
        configured.EnsureSuccessStatusCode();
        using var agent = Agent(source);
        var plan = (await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
        var now = DateTimeOffset.UtcNow;
        var summary = FailureSummary(plan, target.Id, now.AddSeconds(-1));
        var directory = Path.Combine(Path.GetTempPath(), $"connectivity-ack-{Guid.NewGuid():N}");
        try
        {
            var spool = new CabinetPlatform.Agent.Connectivity.ConnectivitySpool(directory);
            Assert.True(spool.Enqueue(summary, now));
            var sampler = new CabinetPlatform.Agent.Connectivity.ConnectivitySampler(source.Id, new ConnectivitySamplerTests.SequenceProbe(CabinetPlatform.Agent.Connectivity.ProbeObservation.Reply), _ => true);
            using var broken = new HttpClient(new DropCommittedAck { InnerHandler = _host.Server.CreateHandler() }) { BaseAddress = new Uri("http://localhost") };
            broken.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
            broken.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", source.MachineId);
            var first = new CabinetPlatform.Agent.Connectivity.ConnectivityDelivery(broken, spool, sampler);
            await Assert.ThrowsAsync<HttpRequestException>(() => first.DeliverAsync(now, default));
            var reopened = new CabinetPlatform.Agent.Connectivity.ConnectivitySpool(directory);
            Assert.Equal(summary, Assert.Single(reopened.Peek(now)));
            var retry = new CabinetPlatform.Agent.Connectivity.ConnectivityDelivery(agent, reopened, sampler);
            Assert.True(await retry.DeliverAsync(now, default));
            Assert.Empty(reopened.Peek(now));
            var status = (await support.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}", AgentJson.SerializerOptions))!;
            Assert.Single(status.RecentEvidence);
            Assert.True(Assert.Single(status.Links).IncidentOpen);
            Assert.Equal(3, status.Links[0].ConsecutiveFailures);
            using var altered = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { summary with
            {
                SuccessCount = 3, FailureCount = 0, LeadingFailures = 0, TrailingFailures = 0,
                MaximumFailureRun = 0, LastFailureUtc = null, LastSuccessUtc = summary.LastObservedUtc
            } }, AgentJson.SerializerOptions);
            Assert.Equal(HttpStatusCode.Conflict, altered.StatusCode);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private sealed class ViewClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; }
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class DropCommittedAck : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = await base.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();
            response.Dispose();
            throw new HttpRequestException("Synthetic connection loss after real server commit");
        }
    }

    private static CabinetPlatform.Contracts.Telemetry.ConnectivitySummary FailureSummary(
        CabinetPlatform.Contracts.Telemetry.ConnectivityPlan plan, Guid target, DateTimeOffset last) => new()
    {
        Id = Guid.NewGuid(), ConfigurationId = plan.ConfigurationId, SourceCabinetId = plan.SourceCabinetId, TargetCabinetId = target,
        FirstObservedUtc = last.AddMinutes(-2), LastObservedUtc = last, FailureCount = 3, LeadingFailures = 3,
        TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = last
    };

    [Fact(Skip = "Historical target dispatch is retired")]
    public async Task Changing_target_topology_removes_dispatch_and_refuses_late_evidence()
    {
        var site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("topology-source", site: site);
        var target = await _host.CreateCabinetAsync("topology-target", site: site);
        var other = await _host.CreateCabinetAsync("different-site", site: site + "different");
        using var support = await SupportAsync();
        using var configure = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "Synthetic topology revocation", targets = new[] { new { cabinetId = target.Id, address = "192.168.50.20" } }
        });
        configure.EnsureSuccessStatusCode();
        using var agent = Agent(source);
        var plan = (await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
        using (var scope = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.CreateScope(_host.Services))
        {
            var db = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<CabinetPlatform.Server.Data.SupportDbContext>(scope.ServiceProvider);
            var moved = await db.Cabinets.FindAsync(target.Id);
            moved!.SiteId = other.SiteId;
            await db.SaveChangesAsync();
        }
        var current = (await agent.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
        Assert.Empty(current.Targets);
        using var report = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { FailureSummary(plan, target.Id, DateTimeOffset.UtcNow.AddSeconds(-1)) }, AgentJson.SerializerOptions);
        Assert.Equal(HttpStatusCode.Conflict, report.StatusCode);
        var status = (await support.GetFromJsonAsync<CabinetPlatform.Contracts.Telemetry.ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}", AgentJson.SerializerOptions))!;
        Assert.Empty(status.Links);
        Assert.Empty(status.RecentEvidence);
    }

    [Fact(Skip = "Historical peer incident fixture relied on newly configuring retired peer probes")]
    public async Task Three_misses_form_one_incident_and_success_recovers_without_replay_reopening()
    {
        string site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("observing-source", site: site);
        var sync = await _host.CreateCabinetAsync("observed-sync", site: site, role: CabinetRole.Sync);
        using var support = await SupportAsync();
        using var configure = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "Synthetic failure and recovery", targets = new[] { new { cabinetId = sync.Id, address = "192.168.50.20" } }
        });
        configure.EnsureSuccessStatusCode();
        using var agent = Agent(source);
        var plan = await agent.GetFromJsonAsync<System.Text.Json.JsonElement>("/api/agent/connectivity/plan");
        var revision = plan.GetProperty("configurationId").GetGuid();
        var start = DateTimeOffset.UtcNow.AddMinutes(-8);
        object Summary(Guid id, DateTimeOffset first, bool failed) => new
        {
            id, configurationId = revision, sourceCabinetId = source.Id, targetCabinetId = sync.Id,
            firstObservedUtc = first, lastObservedUtc = first.AddMinutes(2),
            successCount = failed ? 0 : 3, failureCount = failed ? 3 : 0, errorCount = 0,
            leadingFailures = failed ? 3 : 0, trailingFailures = failed ? 3 : 0, maximumFailureRun = failed ? 3 : 0,
            lastSuccessUtc = failed ? (DateTimeOffset?)null : first.AddMinutes(2),
            lastFailureUtc = failed ? first.AddMinutes(2) : (DateTimeOffset?)null
        };
        var failure = Summary(Guid.NewGuid(), start, true);
        using var reported = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { failure });
        Assert.Equal(HttpStatusCode.OK, reported.StatusCode);
        var state = await support.GetFromJsonAsync<System.Text.Json.JsonElement>($"/api/connectivity/cabinets/{source.Id}");
        var link = state.GetProperty("links")[0];
        Assert.Equal("Unreachable", link.GetProperty("condition").GetString());
        Assert.True(link.GetProperty("incidentOpen").GetBoolean());
        Assert.True(link.GetProperty("isStale").GetBoolean());
        Assert.Equal(start.AddMinutes(2), link.GetProperty("observedUtc").GetDateTimeOffset());
        Assert.True(link.GetProperty("receivedUtc").GetDateTimeOffset() > start.AddMinutes(2));
        using var recovery = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { Summary(Guid.NewGuid(), start.AddMinutes(3), false) });
        recovery.EnsureSuccessStatusCode();
        using var replay = await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { failure });
        replay.EnsureSuccessStatusCode();
        state = await support.GetFromJsonAsync<System.Text.Json.JsonElement>($"/api/connectivity/cabinets/{source.Id}");
        link = state.GetProperty("links")[0];
        Assert.Equal("Reachable", link.GetProperty("condition").GetString());
        Assert.False(link.GetProperty("incidentOpen").GetBoolean());
        Assert.Equal(start.AddMinutes(5), link.GetProperty("recoveredObservedUtc").GetDateTimeOffset());
        Assert.Equal(2, state.GetProperty("recentEvidence").GetArrayLength());
        Assert.Equal(3, state.GetProperty("recentEvidence")[1].GetProperty("summary").GetProperty("failureCount").GetInt32());
    }

    [Fact(Skip = "Retired behavior: supervisor cannot issue targets; new refusal tests cover this")]
    public async Task Supervisor_pins_registered_same_site_targets_and_agent_receives_bounded_plan()
    {
        string site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("source", site: site);
        var sync = await _host.CreateCabinetAsync("sync", site: site, role: CabinetRole.Sync);
        using var support = await SupportAsync();
        using var configured = await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
        {
            reason = "Approved synthetic office lab", targets = new[] { new { cabinetId = sync.Id, address = "192.168.50.20" } }
        }, AgentJson.SerializerOptions);
        Assert.Equal(HttpStatusCode.OK, configured.StatusCode);
        using var agent = Agent(source);
        using var plan = await agent.GetAsync("/api/agent/connectivity/plan");
        Assert.Equal(HttpStatusCode.OK, plan.StatusCode);
        var json = await plan.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        Assert.Equal(60, json.GetProperty("intervalSeconds").GetInt32());
        Assert.Equal(sync.Id, json.GetProperty("targets")[0].GetProperty("cabinetId").GetGuid());
        Assert.Equal("192.168.50.20", json.GetProperty("targets")[0].GetProperty("address").GetString());
        Assert.True(json.GetProperty("targets")[0].GetProperty("isSync").GetBoolean());
    }
}
