using System.Net;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

// Sequential reproducer adapted from the independent retirement review.
public sealed class CabinetRetirementTopologyTests
{
    [Fact]
    public async Task Retry_repairs_restored_designation_without_rewriting_history_or_success_audit()
    {
        using var f = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(f, Role.Supervisor, "retry-topology");
        var old = await TestClient.CreateApprovedCabinetAsync(f, "retry-old", user.Id, role: CabinetRole.Sync);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{old.Id}/retire", new { Reason = "original reason" })).StatusCode);
        await f.WithDbAsync(db => db.Sites.Where(s => s.Id == old.SiteId)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.SyncCabinetId, old.Id)));
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{old.Id}/retire", new { Reason = "repair retry" })).StatusCode);
        await f.WithDbAsync(async db =>
        {
            var saved = await db.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == old.Id);
            Assert.Null(saved.Site!.SyncCabinetId);
            Assert.False(saved.IsActive);
            Assert.Equal(old.Role, saved.Role);
            Assert.Equal(old.ApprovedUtc, saved.ApprovedUtc);
            Assert.Equal(old.ApprovedByUserId, saved.ApprovedByUserId);
            var audit = Assert.Single(await db.AuditEntries.Where(a => a.CabinetId == old.Id && a.Event == CabinetPlatform.Contracts.Audit.AuditEvent.RetireCabinet).ToListAsync());
            Assert.Equal("original reason", audit.Reason);
        });
    }

    [Fact]
    public async Task Retired_sync_cannot_be_reinstalled_as_operational_sync_by_role_edit()
    {
        using var f = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(f, Role.Supervisor, "review-topology");
        var retired = await TestClient.CreateApprovedCabinetAsync(f, "review-old-sync", user.Id, role: CabinetRole.Sync);
        var replacement = await TestClient.CreateApprovedCabinetAsync(f, "review-new-sync", user.Id);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{retired.Id}/retire", new { Reason = "retire old sync" })).StatusCode);
        Assert.Null(await f.WithDbAsync(db => db.Sites.Where(s => s.Id == retired.SiteId).Select(s => s.SyncCabinetId).SingleAsync()));
        // A supervisor acting on the retained historical detail must not restore
        // an inactive identity to operational topology. Either reject the edit,
        // or preserve a historical role without designating the inactive row.
        var roleEdit = await client.PutJsonAsync($"/api/cabinets/{retired.Id}/role", new { Role = CabinetRole.Sync, Reason = "stale role confirmation" });
        Assert.Equal(HttpStatusCode.Conflict, roleEdit.StatusCode);
        var denied = await f.WithDbAsync(db => db.AuditEntries.Where(a => a.CabinetId == retired.Id &&
            a.Event == CabinetPlatform.Contracts.Audit.AuditEvent.SetCabinetRole).ToListAsync());
        Assert.Equal(CabinetPlatform.Contracts.Audit.AuditResult.Denied, Assert.Single(denied).Result);
        var retry = await client.PostJsonAsync($"/api/cabinets/{retired.Id}/retire", new { Reason = "idempotent retry" });
        Assert.Equal(HttpStatusCode.NoContent, retry.StatusCode);
        Assert.False(await f.WithDbAsync(db => db.Cabinets.Where(c => c.Id == retired.Id).Select(c => c.IsActive).SingleAsync()));
        var site = (await (await client.GetAsync($"/api/fleet/sites/{retired.SiteId}")).ReadAsync<SiteDetailDto>())!;
        var replacementEdit = await client.PutJsonAsync($"/api/cabinets/{replacement.Id}/role", new { Role = CabinetRole.Sync, Reason = "designate active replacement" });
        Assert.True(site.Site.SyncCabinetId is null && replacementEdit.StatusCode == HttpStatusCode.OK,
            $"Retired-role edit HTTP {(int)roleEdit.StatusCode}; retirement retry HTTP {(int)retry.StatusCode}; operational sync points to retired identity: {site.Site.SyncCabinetId == retired.Id}; active cabinet count {site.Site.CabinetCount}; replacement designation HTTP {(int)replacementEdit.StatusCode}.");
    }
}
