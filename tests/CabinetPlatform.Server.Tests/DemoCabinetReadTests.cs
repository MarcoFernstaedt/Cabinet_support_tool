using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class DemoCabinetReadTests
{
    [Fact]
    public async Task Exact_grant_returns_only_bounded_cabinet_identity_without_recent_view_write()
    {
        using var factory = new SupportApiFactory();
        var (staff, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "demo-reader");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "demo-machine", user.Id);
        await factory.WithDbAsync(async db =>
        {
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id });
            await db.SaveChangesAsync();
        });

        using var response = await staff.GetAsync($"/api/demo/cabinets/{cabinet.Id}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        Assert.Equal(cabinet.Id, root.GetProperty("cabinetId").GetGuid());
        Assert.Equal(cabinet.Hostname, root.GetProperty("hostname").GetString());
        Assert.Equal("Main Clinic", root.GetProperty("siteName").GetString());
        Assert.Equal("Test Veterinary Group", root.GetProperty("clientName").GetString());
        Assert.Equal(new[] { "cabinetId", "clientName", "friendlyName", "hostname", "siteName" },
            root.EnumerateObject().Select(p => p.Name).OrderBy(x => x).ToArray());
        Assert.Equal(0, await factory.WithDbAsync(db => db.RecentCabinetViews.CountAsync()));
    }

    [Fact]
    public async Task No_role_site_or_sync_relationship_grants_another_cabinet_or_user()
    {
        using var factory = new SupportApiFactory();
        var (owner, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "scoped-owner");
        var (supervisor, other) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "ungranted-supervisor");
        Cabinet allowed = await TestClient.CreateApprovedCabinetAsync(factory, "scoped-main", user.Id);
        Cabinet sync = await TestClient.CreateApprovedCabinetAsync(factory, "scoped-sync", other.Id,
            role: CabinetPlatform.Contracts.Cabinets.CabinetRole.Sync);
        await factory.WithDbAsync(async db =>
        {
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = allowed.Id });
            await db.SaveChangesAsync();
        });
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await anonymous.GetAsync($"/api/demo/cabinets/{allowed.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await supervisor.GetAsync($"/api/demo/cabinets/{allowed.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await owner.GetAsync($"/api/demo/cabinets/{sync.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await owner.GetAsync($"/api/demo/cabinets/{Guid.NewGuid()}")).StatusCode);
        Assert.Equal(0, await factory.WithDbAsync(db => db.RecentCabinetViews.CountAsync()));
    }

    [Fact]
    public async Task Revocation_and_account_containment_take_effect_on_next_request()
    {
        using var factory = new SupportApiFactory();
        var (reader, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "revoked-reader");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "revoked-cabinet", user.Id);
        await factory.WithDbAsync(async db =>
        {
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id });
            await db.SaveChangesAsync();
        });
        string url = $"/api/demo/cabinets/{cabinet.Id}";
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync(url)).StatusCode);
        await factory.WithDbAsync(async db =>
        {
            await db.CabinetReadGrants.Where(g => g.UserId == user.Id && g.CabinetId == cabinet.Id)
                .ExecuteDeleteAsync();
        });
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync(url)).StatusCode);
        await factory.WithDbAsync(async db =>
        {
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id });
            await db.SaveChangesAsync();
            await db.Users.Where(u => u.Id == user.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(u => u.MustChangePassword, true));
        });
        Assert.NotEqual(HttpStatusCode.OK, (await reader.GetAsync(url)).StatusCode);
        await factory.WithDbAsync(async db =>
            await db.Users.Where(u => u.Id == user.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(u => u.IsActive, false)));
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.GetAsync(url)).StatusCode);
    }
}
