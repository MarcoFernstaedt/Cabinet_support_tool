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
    public async Task Sync_failure_alert_exposes_source_check_without_claiming_firewall_cause()
    {
        var (supervisor, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        string site = Guid.NewGuid().ToString();
        var source = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        var target = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id,
            siteName: site, role: CabinetPlatform.Contracts.Cabinets.CabinetRole.Sync);
        (await supervisor.PutJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new ConfigureConnectivityRequest
        { Reason = "Synthetic test", Targets = [new ConnectivityTarget { CabinetId = target.Id, Address = "192.168.10.2" }] })).EnsureSuccessStatusCode();
        using var agent = TestClient.CreateAgentClient(_factory, source.MachineId);
        var plan = await (await agent.GetAsync("/api/agent/connectivity/plan")).ReadAsync<ConnectivityPlan>();
        Assert.True(Assert.Single(plan!.Targets).IsSync);
        var first = DateTimeOffset.UtcNow.AddMinutes(-4);
        var summary = new ConnectivitySummary
        {
            Id = Guid.NewGuid(), ConfigurationId = plan.ConfigurationId, SourceCabinetId = source.Id, TargetCabinetId = target.Id,
            FirstObservedUtc = first, LastObservedUtc = first.AddMinutes(2), FailureCount = 3,
            LeadingFailures = 3, TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = first.AddMinutes(2),
            SourceFirewallCheck = new() { ObservedUtc = first.AddMinutes(2).AddSeconds(1), Status = FirewallReadStatus.Read,
                HasOutboundProfileBlockClue = true }
        };
        Assert.Equal(HttpStatusCode.OK, (await agent.PostJsonAsync("/api/agent/connectivity/summaries", new[] { summary })).StatusCode);
        var page = await (await supervisor.GetAsync($"/api/connectivity-alerts?sourceCabinetId={source.Id}")).ReadAsync<JsonElement>();
        var alert = Assert.Single(page.GetProperty("items").EnumerateArray());
        Assert.True(alert.GetProperty("sourceFirewallCheck").GetProperty("hasOutboundProfileBlockClue").GetBoolean());
        // Simulate a retained 15-day incident; ordinary evidence normally expires after 14 days.
        await _factory.WithDbAsync(async db =>
        {
            var evidence = await db.ConnectivityEvidence.SingleAsync(e => e.Id == summary.Id);
            evidence.FirstObservedUtc = evidence.FirstObservedUtc.AddDays(-15);
            evidence.ObservedUtc = evidence.ObservedUtc.AddDays(-15);
            var row = await db.ConnectivityAlerts.SingleAsync(a => a.EvidenceId == summary.Id);
            row.ReceivedUtc = row.ReceivedUtc.AddDays(-15);
            await db.SaveChangesAsync();
        });
        (await agent.PostJsonAsync("/api/agent/connectivity/summaries", new[] { summary })).EnsureSuccessStatusCode();
        var retained = await (await supervisor.GetAsync($"/api/connectivity-alerts?sourceCabinetId={source.Id}")).ReadAsync<JsonElement>();
        Assert.True(Assert.Single(retained.GetProperty("items").EnumerateArray())
            .GetProperty("sourceFirewallCheck").GetProperty("hasOutboundProfileBlockClue").GetBoolean());
        Assert.Equal("Open", alert.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Accepted_incident_creates_one_source_bound_alert_even_on_replay()
    {
        var (supervisor, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        string site = Guid.NewGuid().ToString();
        var source = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        var target = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        (await supervisor.PutJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new ConfigureConnectivityRequest
        { Reason = "Lab", Targets = new[] { new ConnectivityTarget { CabinetId = target.Id, Address = "192.168.10.2" } } })).EnsureSuccessStatusCode();
        var agent = TestClient.CreateAgentClient(_factory, source.MachineId);
        var plan = await (await agent.GetAsync("/api/agent/connectivity/plan")).ReadAsync<ConnectivityPlan>();
        var first = DateTimeOffset.UtcNow.AddMinutes(-4);
        var summary = new ConnectivitySummary
        {
            Id = Guid.NewGuid(), ConfigurationId = plan!.ConfigurationId, SourceCabinetId = source.Id, TargetCabinetId = target.Id,
            FirstObservedUtc = first, LastObservedUtc = first.AddMinutes(2), FailureCount = 3,
            LeadingFailures = 3, TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = first.AddMinutes(2)
        };
        Assert.Equal(HttpStatusCode.BadRequest, (await agent.PostJsonAsync("/api/agent/connectivity/summaries", new[] {
            summary with { SourceFirewallCheck = new() { ObservedUtc = first.AddMinutes(2).AddSeconds(1),
                Status = FirewallReadStatus.Read, HasOutboundProfileBlockClue = true } }
        })).StatusCode);
        (await agent.PostJsonAsync("/api/agent/connectivity/summaries", new[] { summary })).EnsureSuccessStatusCode();
        (await agent.PostJsonAsync("/api/agent/connectivity/summaries", new[] { summary })).EnsureSuccessStatusCode();
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
