using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class ConnectivityAlertTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public ConnectivityAlertTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Site_workload_counts_all_retained_statuses_before_queue_pagination()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        string duplicate = Guid.NewGuid().ToString();
        var first = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id,
            clientName: "Client A", siteName: duplicate);
        var peer = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id,
            clientName: "Client A", siteName: duplicate);
        var other = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id,
            clientName: "Client B", siteName: duplicate);
        var now = DateTimeOffset.UtcNow;
        await _factory.WithDbAsync(async db =>
        {
            for (int i = 0; i < 55; i++) db.ConnectivityAlerts.Add(new CabinetPlatform.Server.Domain.ConnectivityAlert
            { SourceCabinetId = i % 2 == 0 ? first.Id : peer.Id, TargetCabinetId = other.Id, EvidenceId = Guid.NewGuid(), ReceivedUtc = now });
            foreach (var (source, status, received) in new[] {
                (first.Id, "Acknowledged", now), (peer.Id, "Resolved", now),
                (other.Id, "Open", now), (first.Id, "Open", now.AddDays(-31)) })
                db.ConnectivityAlerts.Add(new CabinetPlatform.Server.Domain.ConnectivityAlert
                { SourceCabinetId = source, TargetCabinetId = other.Id, EvidenceId = Guid.NewGuid(), Status = status, ReceivedUtc = received });
            await db.SaveChangesAsync();
        });
        var response = await support.GetAsync($"/api/connectivity-alerts/site/{first.SiteId}/summary");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var summary = await response.ReadAsync<ConnectivitySiteWorkloadDto>();
        Assert.NotNull(summary);
        Assert.Equal(first.SiteId, summary.SiteId);
        Assert.Equal(55, summary.Open);
        Assert.Equal(1, summary.Acknowledged);
        Assert.Equal(1, summary.Resolved);
        Assert.Equal(57, summary.Total);
        Assert.InRange(summary.AsOfUtc, now.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync($"/api/connectivity-alerts/site/{first.SiteId}/summary")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await support.GetAsync($"/api/connectivity-alerts/site/{Guid.Empty}/summary")).StatusCode);
    }

    [Fact]
    public async Task Authenticated_site_queue_uses_source_site_identity_not_duplicate_site_names()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Guid.NewGuid().ToString());
        string duplicate = Guid.NewGuid().ToString();
        var first = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id,
            clientName: "Client A", siteName: duplicate);
        var second = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id,
            clientName: "Client B", siteName: duplicate);
        await _factory.WithDbAsync(async db =>
        {
            db.ConnectivityAlerts.AddRange(new CabinetPlatform.Server.Domain.ConnectivityAlert
            { SourceCabinetId = first.Id, TargetCabinetId = Guid.NewGuid(), EvidenceId = Guid.NewGuid(), ReceivedUtc = DateTimeOffset.UtcNow },
                new CabinetPlatform.Server.Domain.ConnectivityAlert
                { SourceCabinetId = second.Id, TargetCabinetId = Guid.NewGuid(), EvidenceId = Guid.NewGuid(), ReceivedUtc = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
        });
        var selected = await (await support.GetAsync($"/api/connectivity-alerts?siteId={first.SiteId}")).ReadAsync<JsonElement>();
        Assert.Equal(1, selected.GetProperty("totalCount").GetInt32());
        var row = Assert.Single(selected.GetProperty("items").EnumerateArray());
        Assert.Equal(first.Id, row.GetProperty("sourceCabinetId").GetGuid());
        Assert.Equal(first.SiteId, row.GetProperty("siteId").GetGuid());
        var other = await (await support.GetAsync($"/api/connectivity-alerts?siteId={second.SiteId}&sourceCabinetId={first.Id}")).ReadAsync<JsonElement>();
        Assert.Equal(0, other.GetProperty("totalCount").GetInt32());
        Assert.Empty(other.GetProperty("items").EnumerateArray());
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync($"/api/connectivity-alerts?siteId={first.SiteId}")).StatusCode);
    }

    [Fact]
    public async Task Retained_sync_failure_alert_exposes_historical_firewall_clue()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var source = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var target = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var first = DateTimeOffset.UtcNow.AddDays(-15);
        var summary = new ConnectivitySummary
        {
            Id = Guid.NewGuid(), ConfigurationId = Guid.NewGuid(), SourceCabinetId = source.Id, TargetCabinetId = target.Id,
            FirstObservedUtc = first, LastObservedUtc = first.AddMinutes(2), FailureCount = 3,
            LeadingFailures = 3, TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = first.AddMinutes(2),
            SourceFirewallCheck = new() { ObservedUtc = first.AddMinutes(2).AddSeconds(1), Status = FirewallReadStatus.Read,
                HasOutboundProfileBlockClue = true }
        };
        await _factory.WithDbAsync(async db =>
        {
            db.ConnectivityEvidence.Add(new CabinetPlatform.Server.Domain.ConnectivityEvidence
            {
                Id = summary.Id, SourceCabinetId = source.Id, TargetCabinetId = target.Id,
                ConfigurationId = summary.ConfigurationId, FirstObservedUtc = summary.FirstObservedUtc,
                ObservedUtc = summary.LastObservedUtc, ReceivedUtc = first.AddMinutes(3),
                SummaryJson = JsonSerializer.Serialize(summary, CabinetPlatform.Contracts.Common.ContractJson.Default)
            });
            db.ConnectivityAlerts.Add(new CabinetPlatform.Server.Domain.ConnectivityAlert
            {
                SourceCabinetId = source.Id, TargetCabinetId = target.Id, EvidenceId = summary.Id,
                ObservedUtc = summary.LastObservedUtc, ReceivedUtc = first.AddMinutes(3)
            });
            await db.SaveChangesAsync();
        });
        var page = await (await support.GetAsync($"/api/connectivity-alerts?sourceCabinetId={source.Id}")).ReadAsync<JsonElement>();
        var alert = Assert.Single(page.GetProperty("items").EnumerateArray());
        Assert.True(alert.GetProperty("sourceFirewallCheck").GetProperty("hasOutboundProfileBlockClue").GetBoolean());
        Assert.Equal(summary.Id, alert.GetProperty("incidentEvidence").GetProperty("id").GetGuid());
        Assert.Equal(3, alert.GetProperty("incidentEvidence").GetProperty("failureCount").GetInt32());
        Assert.Equal("Open", alert.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Seeded_historical_alert_is_source_bound_and_operator_transitions_remain_audited()
    {
        var (supervisor, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        string site = Guid.NewGuid().ToString();
        var source = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        var target = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        var agent = TestClient.CreateAgentClient(_factory, source.MachineId);
        var first = DateTimeOffset.UtcNow.AddMinutes(-4);
        var summary = new ConnectivitySummary
        {
            Id = Guid.NewGuid(), ConfigurationId = Guid.NewGuid(), SourceCabinetId = source.Id, TargetCabinetId = target.Id,
            FirstObservedUtc = first, LastObservedUtc = first.AddMinutes(2), FailureCount = 3,
            LeadingFailures = 3, TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = first.AddMinutes(2)
        };
        await _factory.WithDbAsync(async db =>
        {
            db.ConnectivityConfigurations.Add(new CabinetPlatform.Server.Domain.ConnectivityConfiguration
            {
                SourceCabinetId = source.Id, SiteId = source.SiteId, ConfigurationId = summary.ConfigurationId,
                TargetsJson = JsonSerializer.Serialize(new[] { new ConnectivityTarget { CabinetId = target.Id, Address = "192.168.10.2" } }),
                StatesJson = "[]", UpdatedUtc = first
            });
            db.ConnectivityEvidence.Add(new CabinetPlatform.Server.Domain.ConnectivityEvidence
            {
                Id = summary.Id, SourceCabinetId = source.Id, TargetCabinetId = target.Id, ConfigurationId = summary.ConfigurationId,
                FirstObservedUtc = first, ObservedUtc = summary.LastObservedUtc, ReceivedUtc = first.AddMinutes(3),
                SummaryJson = JsonSerializer.Serialize(summary, CabinetPlatform.Contracts.Common.ContractJson.Default)
            });
            db.ConnectivityAlerts.Add(new CabinetPlatform.Server.Domain.ConnectivityAlert
            {
                SourceCabinetId = source.Id, TargetCabinetId = target.Id, EvidenceId = summary.Id,
                ObservedUtc = summary.LastObservedUtc, ReceivedUtc = first.AddMinutes(3)
            });
            await db.SaveChangesAsync();
        });
        // Retired ingestion cannot add another incident or replay an existing one.
        Assert.Equal(HttpStatusCode.Gone, (await agent.PostJsonAsync("/api/agent/connectivity/summaries", new[] { summary })).StatusCode);
        Assert.Equal(HttpStatusCode.Gone, (await agent.PostJsonAsync("/api/agent/connectivity/summaries", new[] { summary with { Id = Guid.NewGuid() } })).StatusCode);
        Assert.Equal(1, await _factory.WithDbAsync(db => db.ConnectivityAlerts.CountAsync(a => a.SourceCabinetId == source.Id)));
        var response = await supervisor.GetAsync($"/api/connectivity-alerts?sourceCabinetId={source.Id}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var page = await response.ReadAsync<JsonElement>();
        var alert = Assert.Single(page.GetProperty("items").EnumerateArray());
        Assert.Equal(source.Id, alert.GetProperty("sourceCabinetId").GetGuid());
        Assert.Equal(target.Id, alert.GetProperty("targetCabinetId").GetGuid());
        Assert.Equal(summary.Id, alert.GetProperty("evidenceId").GetGuid());
        Assert.Equal("Open", alert.GetProperty("status").GetString());
        Assert.Equal(first.AddMinutes(2), alert.GetProperty("observedUtc").GetDateTimeOffset());
        Assert.Equal(1, await _factory.WithDbAsync(db => db.ConnectivityEvidence.CountAsync(e => e.SourceCabinetId == source.Id)));
        Guid alertId = alert.GetProperty("id").GetGuid();
        string before = await _factory.WithDbAsync(db => db.ConnectivityConfigurations.Where(c => c.SourceCabinetId == source.Id).Select(c => c.StatesJson).SingleAsync());
        foreach (var role in new[] { Role.Tier1, Role.Tier2 })
        {
            var (support, actor) = await TestClient.CreateUserClientAsync(_factory, role, Guid.NewGuid().ToString());
            string operation = role == Role.Tier1 ? "acknowledge" : "resolve";
            foreach (string note in new[] { " ", new string('x', 1001) })
                Assert.Equal(HttpStatusCode.BadRequest, (await support.PostJsonAsync($"/api/connectivity-alerts/{alertId}/{operation}",
                    new { SourceCabinetId = source.Id, Note = note })).StatusCode);
            var bad = await support.PostJsonAsync($"/api/connectivity-alerts/{alertId}/{operation}", new { SourceCabinetId = target.Id, Note = "Wrong source" });
            Assert.Equal(HttpStatusCode.NotFound, bad.StatusCode);
            var changed = await support.PostJsonAsync($"/api/connectivity-alerts/{alertId}/{operation}", new { SourceCabinetId = source.Id, Note = "Operator reviewed evidence" });
            Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
            var audit = await _factory.WithDbAsync(db => db.AuditEntries.SingleAsync(a => a.CabinetId == source.Id && a.ActorId == actor.Id.ToString() && a.Reason == "Operator reviewed evidence"));
            Assert.Equal(actor.Username, audit.ActorDisplayName);
            Assert.Contains(alertId.ToString(), audit.Details!);
            var readback = await (await support.GetAsync($"/api/connectivity-alerts?sourceCabinetId={source.Id}&includeResolved=true")).ReadAsync<JsonElement>();
            Assert.Equal(role == Role.Tier1 ? "Acknowledged" : "Resolved", Assert.Single(readback.GetProperty("items").EnumerateArray()).GetProperty("status").GetString());
        }
        Assert.Equal(before, await _factory.WithDbAsync(db => db.ConnectivityConfigurations.Where(c => c.SourceCabinetId == source.Id).Select(c => c.StatesJson).SingleAsync()));
        Assert.Equal(2, await _factory.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.CabinetId == source.Id && a.Reason == "Operator reviewed evidence")));
        foreach (var denied in new[] { _factory.CreateClient(), agent })
        {
            var mutation = await denied.PostJsonAsync($"/api/connectivity-alerts/{alertId}/resolve", new { SourceCabinetId = source.Id, Note = "Forbidden" });
            Assert.True(mutation.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden);
        }
        Assert.Equal(HttpStatusCode.Conflict, (await supervisor.PostJsonAsync($"/api/connectivity-alerts/{alertId}/acknowledge", new { SourceCabinetId = source.Id, Note = "Must not reopen" })).StatusCode);
    }
}
