using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class ConnectivityCorrelationTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public ConnectivityCorrelationTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Accepted_interval_is_pinned_and_contact_is_distinct_from_old_measurement()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var site = Guid.NewGuid().ToString();
        var source = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        var target = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site, role: CabinetPlatform.Contracts.Cabinets.CabinetRole.Sync);
        var peer = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: site);
        var old = DateTimeOffset.UtcNow.AddDays(-10);
        var recent = DateTimeOffset.UtcNow;
        var accepted = new ConnectivitySummary { Id = Guid.NewGuid(), SourceCabinetId = source.Id, TargetCabinetId = target.Id,
            FirstObservedUtc = old, LastObservedUtc = old.AddMinutes(2), FailureCount = 3,
            SourceFirewallCheck = new() { ObservedUtc = old.AddMinutes(2), Status = FirewallReadStatus.Read, HasOutboundProfileBlockClue = true } };
        var alert = new ConnectivityAlert { SourceCabinetId = source.Id, TargetCabinetId = target.Id, EvidenceId = accepted.Id,
            Status = "Resolved", ReceivedUtc = recent.AddMinutes(-1) };
        await _factory.WithDbAsync(async db =>
        {
            db.Cabinets.Single(c => c.Id == source.Id).LastCheckInUtc = recent;
            db.Cabinets.Single(c => c.Id == target.Id).LastCheckInUtc = recent.AddMinutes(-2);
            db.Heartbeats.AddRange(new Heartbeat { CabinetId = source.Id, CollectedAtUtc = old, ReceivedUtc = recent },
                new Heartbeat { CabinetId = target.Id, CollectedAtUtc = old.AddHours(1), ReceivedUtc = recent.AddMinutes(-2) });
            db.ConnectivityEvidence.AddRange(new ConnectivityEvidence { Id = accepted.Id, SourceCabinetId = source.Id, TargetCabinetId = target.Id,
                FirstObservedUtc = old, ObservedUtc = old.AddMinutes(2), ReceivedUtc = recent.AddMinutes(-1), SummaryJson = JsonSerializer.Serialize(accepted, ContractJson.Default) },
                new ConnectivityEvidence { Id = Guid.NewGuid(), SourceCabinetId = source.Id, TargetCabinetId = peer.Id,
                    FirstObservedUtc = recent, ObservedUtc = recent, ReceivedUtc = recent, SummaryJson = JsonSerializer.Serialize(accepted with { Id = Guid.NewGuid(), TargetCabinetId = peer.Id }, ContractJson.Default) });
            db.ConnectivityAlerts.Add(alert);
            await db.SaveChangesAsync();
        });
        var response = await support.GetAsync($"/api/connectivity-alerts/{alert.Id}/correlation");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.ReadAsync<JsonElement>();
        Assert.Equal(new[] { "alertId", "siteId", "sourceCabinetId", "targetCabinetId", "status", "evidenceId", "interval", "source", "target", "currentSyncCabinetId", "targetIsCurrentSync", "topologyClaim", "applicationPortEvidence", "resolutionClaim" }.Order(), json.EnumerateObject().Select(p => p.Name).Order());
        Assert.Equal(alert.Id, json.GetProperty("alertId").GetGuid());
        Assert.Equal(source.SiteId, json.GetProperty("siteId").GetGuid());
        Assert.Equal(target.Id, json.GetProperty("currentSyncCabinetId").GetGuid());
        Assert.True(json.GetProperty("targetIsCurrentSync").GetBoolean());
        Assert.Contains("current", json.GetProperty("topologyClaim").GetString()!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("not", json.GetProperty("applicationPortEvidence").GetString()!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("not", json.GetProperty("resolutionClaim").GetString()!, StringComparison.OrdinalIgnoreCase);
        var interval = json.GetProperty("interval");
        Assert.Equal(new[] { "firstObservedUtc", "lastObservedUtc", "receivedUtc", "successCount", "failureCount", "errorCount", "sourceFirewallCheck" }.Order(), interval.EnumerateObject().Select(p => p.Name).Order());
        Assert.Equal(old, interval.GetProperty("firstObservedUtc").GetDateTimeOffset());
        Assert.Equal(old.AddMinutes(2), interval.GetProperty("lastObservedUtc").GetDateTimeOffset());
        Assert.Equal(recent.AddMinutes(-1), interval.GetProperty("receivedUtc").GetDateTimeOffset());
        Assert.Equal(3, interval.GetProperty("failureCount").GetInt32());
        Assert.True(interval.GetProperty("sourceFirewallCheck").GetProperty("hasOutboundProfileBlockClue").GetBoolean());
        Assert.Equal(recent, json.GetProperty("source").GetProperty("lastCheckInUtc").GetDateTimeOffset());
        Assert.Equal(old, json.GetProperty("source").GetProperty("latestHeartbeatCollectedAtUtc").GetDateTimeOffset());
        Assert.Equal(recent, json.GetProperty("source").GetProperty("latestHeartbeatReceivedAtUtc").GetDateTimeOffset());
        Assert.Equal(target.Id, json.GetProperty("target").GetProperty("cabinetId").GetGuid());
        Assert.Equal(old.AddHours(1), json.GetProperty("target").GetProperty("latestHeartbeatCollectedAtUtc").GetDateTimeOffset());
        Assert.Equal(recent.AddMinutes(-2), json.GetProperty("target").GetProperty("latestHeartbeatReceivedAtUtc").GetDateTimeOffset());
        Assert.Equal(1, await _factory.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.CabinetId == source.Id && a.Event == AuditEvent.ViewConnectivity && a.ActorId == user.Id.ToString())));
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync($"/api/connectivity-alerts/{alert.Id}/correlation")).StatusCode);
        Assert.True((await TestClient.CreateAgentClient(_factory, source.MachineId).GetAsync($"/api/connectivity-alerts/{alert.Id}/correlation")).StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden);

        // A current role change does not rewrite the accepted direction or historical interval.
        await _factory.WithDbAsync(async db => { db.Sites.Single(s => s.Id == source.SiteId).SyncCabinetId = peer.Id; await db.SaveChangesAsync(); });
        json = await (await support.GetAsync($"/api/connectivity-alerts/{alert.Id}/correlation")).ReadAsync<JsonElement>();
        Assert.Equal(peer.Id, json.GetProperty("currentSyncCabinetId").GetGuid());
        Assert.False(json.GetProperty("targetIsCurrentSync").GetBoolean());
        Assert.Equal(target.Id, json.GetProperty("targetCabinetId").GetGuid());
        Assert.Contains("current", json.GetProperty("topologyClaim").GetString()!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Missing_or_mismatched_evidence_never_substitutes_another_interval()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Guid.NewGuid().ToString());
        var source = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: Guid.NewGuid().ToString());
        var other = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id, siteName: Guid.NewGuid().ToString());
        var evidenceId = Guid.NewGuid();
        var alert = new ConnectivityAlert { SourceCabinetId = source.Id, TargetCabinetId = other.Id, EvidenceId = evidenceId, ReceivedUtc = DateTimeOffset.UtcNow };
        await _factory.WithDbAsync(async db => { db.ConnectivityAlerts.Add(alert); await db.SaveChangesAsync(); });
        var url = $"/api/connectivity-alerts/{alert.Id}/correlation";
        var absent = await (await support.GetAsync(url)).ReadAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, absent.GetProperty("interval").ValueKind);
        Assert.Contains("retained interval unavailable", absent.GetProperty("intervalClaim").GetString()!, StringComparison.OrdinalIgnoreCase);
        await _factory.WithDbAsync(async db =>
        {
            db.ConnectivityEvidence.Add(new ConnectivityEvidence { Id = evidenceId, SourceCabinetId = other.Id, TargetCabinetId = source.Id,
                SummaryJson = JsonSerializer.Serialize(new ConnectivitySummary { Id = evidenceId, SourceCabinetId = other.Id, TargetCabinetId = source.Id }, ContractJson.Default) });
            await db.SaveChangesAsync();
        });
        var mismatch = await (await support.GetAsync(url)).ReadAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, mismatch.GetProperty("interval").ValueKind);
        await _factory.WithDbAsync(async db =>
        {
            var row = await db.ConnectivityEvidence.SingleAsync(e => e.Id == evidenceId);
            db.ConnectivityEvidence.Remove(row);
            await db.SaveChangesAsync();
            // A matching indexed row must not expose a mismatched payload.
            db.ConnectivityEvidence.Add(new ConnectivityEvidence { Id = evidenceId, SourceCabinetId = source.Id,
                TargetCabinetId = other.Id, SummaryJson = row.SummaryJson });
            await db.SaveChangesAsync();
        });
        Assert.Equal(JsonValueKind.Null, (await (await support.GetAsync(url)).ReadAsync<JsonElement>()).GetProperty("interval").ValueKind);
        await _factory.WithDbAsync(async db =>
        {
            var row = await db.ConnectivityEvidence.SingleAsync(e => e.Id == evidenceId);
            row.SummaryJson = "{invalid";
            await db.SaveChangesAsync();
        });
        Assert.Equal(JsonValueKind.Null, (await (await support.GetAsync(url)).ReadAsync<JsonElement>()).GetProperty("interval").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await support.GetAsync($"/api/connectivity-alerts/{Guid.NewGuid()}/correlation")).StatusCode);
        await _factory.WithDbAsync(async db =>
        {
            var row = await db.ConnectivityAlerts.SingleAsync(a => a.Id == alert.Id);
            row.ReceivedUtc = DateTimeOffset.UtcNow.AddDays(-31);
            await db.SaveChangesAsync();
        });
        Assert.Equal(HttpStatusCode.NotFound, (await support.GetAsync(url)).StatusCode);
    }
}
