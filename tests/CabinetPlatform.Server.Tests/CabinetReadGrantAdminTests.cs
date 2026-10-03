using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetReadGrantAdminTests
{
    private static string Path(Guid user, Guid cabinet) => $"/api/users/{user}/cabinet-read-grants/{cabinet}";
    private static object Decision(string reason = "Approved synthetic HP demo") => new { Reason = reason, TicketReference = "TEST-123" };
    private static Task<HttpResponseMessage> DeleteJsonAsync(HttpClient client, string path, object decision) =>
        client.SendAsync(new HttpRequestMessage(HttpMethod.Delete, path) { Content = JsonContent.Create(decision) });

    [Fact]
    public async Task Supervisor_grant_is_exact_idempotent_and_actor_audited()
    {
        using var factory = new SupportApiFactory();
        var (supervisor, actor) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "grant-supervisor");
        var (reader, target) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "grant-target");
        var (other, _) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "grant-other");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "grant-cabinet", actor.Id);
        var sibling = await TestClient.CreateApprovedCabinetAsync(factory, "grant-sibling", actor.Id);
        string path = Path(target.Id, cabinet.Id);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/demo/cabinets/{cabinet.Id}")).StatusCode);
        using var granted = await supervisor.PutJsonAsync(path, Decision());
        Assert.Equal(HttpStatusCode.NoContent, granted.StatusCode);
        Assert.Empty(await granted.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NoContent, (await supervisor.PutJsonAsync(path, Decision())).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync($"/api/demo/cabinets/{cabinet.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/demo/cabinets/{sibling.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/api/demo/cabinets/{cabinet.Id}")).StatusCode);
        await factory.WithDbAsync(async db =>
        {
            Assert.Equal(1, await db.CabinetReadGrants.CountAsync());
            var audit = Assert.Single(await db.AuditEntries.Where(a => a.Event == AuditEvent.GrantCabinetRead).ToListAsync());
            Assert.Equal(actor.Id.ToString(), audit.ActorId);
            Assert.Equal(cabinet.Id, audit.CabinetId);
            Assert.Equal("Approved synthetic HP demo", audit.Reason);
            Assert.Equal("TEST-123", audit.TicketReference);
            using var details = JsonDocument.Parse(audit.Details!);
            Assert.Equal(target.Id, details.RootElement.GetProperty("targetUserId").GetGuid());
        });
    }

    [Fact]
    public async Task Only_live_supervisor_can_change_exact_pair_and_invalid_targets_fail_closed()
    {
        using var factory = new SupportApiFactory();
        var (supervisor, actor) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "auth-supervisor");
        var (tier, target) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "auth-tier");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "auth-cabinet", actor.Id);
        var inactive = await TestClient.CreateApprovedCabinetAsync(factory, "auth-inactive", actor.Id, isActive: false);
        string path = Path(target.Id, cabinet.Id);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PutJsonAsync(path, Decision())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await tier.PutJsonAsync(path, Decision())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await DeleteJsonAsync(tier, path, Decision())).StatusCode);
        await factory.WithDbAsync(async db =>
            await db.Users.Where(u => u.Id == actor.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.Role, Role.Tier1)));
        Assert.Equal(HttpStatusCode.Unauthorized, (await supervisor.PutJsonAsync(path, Decision())).StatusCode);
        await factory.WithDbAsync(async db =>
            await db.Users.Where(u => u.Id == actor.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.Role, Role.Supervisor)));
        Assert.Equal(HttpStatusCode.BadRequest, (await supervisor.PutJsonAsync(path, Decision("  "))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await supervisor.PutJsonAsync(Path(Guid.Empty, cabinet.Id), Decision())).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await supervisor.PutJsonAsync(Path(target.Id, inactive.Id), Decision())).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await supervisor.PutJsonAsync(Path(Guid.NewGuid(), cabinet.Id), Decision())).StatusCode);
        await factory.WithDbAsync(async db =>
            await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.MustChangePassword, true)));
        Assert.Equal(HttpStatusCode.NotFound, (await supervisor.PutJsonAsync(path, Decision())).StatusCode);
        await factory.WithDbAsync(async db =>
            await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.IsActive, false)));
        Assert.Equal(HttpStatusCode.NotFound, (await supervisor.PutJsonAsync(path, Decision())).StatusCode);
        Assert.Equal(0, await factory.WithDbAsync(db => db.CabinetReadGrants.CountAsync()));
    }

    [Fact]
    public async Task Revoke_is_idempotent_audited_and_denies_existing_reader_immediately()
    {
        using var factory = new SupportApiFactory();
        var (supervisor, actor) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "revoke-supervisor");
        var (reader, target) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "revoke-target");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "revoke-cabinet", actor.Id);
        string path = Path(target.Id, cabinet.Id);
        Assert.Equal(HttpStatusCode.NoContent, (await supervisor.PutJsonAsync(path, Decision())).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync($"/api/demo/cabinets/{cabinet.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await DeleteJsonAsync(supervisor, path, Decision("Remove approval"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/demo/cabinets/{cabinet.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await DeleteJsonAsync(supervisor, path, Decision("Remove approval"))).StatusCode);
        var audit = Assert.Single(await TestClient.AuditEntriesAsync(factory, AuditEvent.RevokeCabinetRead));
        Assert.Equal(actor.Id.ToString(), audit.ActorId);
        Assert.Equal(target.Id.ToString(), JsonDocument.Parse(audit.Details!).RootElement.GetProperty("targetUserId").GetString());
        Assert.Equal("Remove approval", audit.Reason);
        Assert.Equal(0, await factory.WithDbAsync(db => db.CabinetReadGrants.CountAsync()));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Audit_insert_failure_rolls_back_grant_or_revocation(bool grant)
    {
        using var factory = new SupportApiFactory();
        var (supervisor, actor) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "rollback-supervisor");
        var (reader, target) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "rollback-reader");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "rollback-cabinet", actor.Id);
        string path = Path(target.Id, cabinet.Id);
        if (!grant) Assert.Equal(HttpStatusCode.NoContent, (await supervisor.PutJsonAsync(path, Decision())).StatusCode);
        await factory.WithDbAsync(async db =>
            await db.Database.ExecuteSqlRawAsync(grant
                ? "CREATE TRIGGER deny_read_grant_audit BEFORE INSERT ON AuditEntries WHEN NEW.Event = 147 BEGIN SELECT RAISE(ABORT, 'audit refused'); END"
                : "CREATE TRIGGER deny_read_grant_audit BEFORE INSERT ON AuditEntries WHEN NEW.Event = 148 BEGIN SELECT RAISE(ABORT, 'audit refused'); END"));
        using var response = grant
            ? await supervisor.PutJsonAsync(path, Decision())
            : await DeleteJsonAsync(supervisor, path, Decision());
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal(grant ? 0 : 1, await factory.WithDbAsync(db => db.CabinetReadGrants.CountAsync()));
        Assert.Equal(grant ? HttpStatusCode.NotFound : HttpStatusCode.OK,
            (await reader.GetAsync($"/api/demo/cabinets/{cabinet.Id}")).StatusCode);
    }
}
