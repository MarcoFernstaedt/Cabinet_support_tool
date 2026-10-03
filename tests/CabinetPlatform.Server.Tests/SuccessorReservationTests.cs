using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Server.Tests;

public sealed class SuccessorReservationTests
{
    [Fact]
    public async Task Retired_office_predecessor_reserves_once_without_credentials_or_history_rewrite()
    {
        using var fixture = new ReservationFixture();
        var (host, client, predecessor) = await fixture.CreateAsync();
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/cabinets/{predecessor.Id}/successor-reservation", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{predecessor.Id}/retire", new { Reason = "Synthetic retirement" })).StatusCode);
        string path = $"/api/cabinets/{predecessor.Id}/successor-reservation";
        using var response = await client.PostAsync(path, null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        string machineId = json.RootElement.GetProperty("successorMachineId").GetString()!;
        Assert.StartsWith("successor-", machineId);
        Assert.NotEqual(predecessor.MachineId, machineId);
        Assert.False(json.RootElement.TryGetProperty("token", out _));
        Assert.False(json.RootElement.TryGetProperty("deviceKey", out _));
        using var retry = await client.PostAsync(path, null);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        using var retryJson = JsonDocument.Parse(await retry.Content.ReadAsStringAsync());
        Assert.Equal(machineId, retryJson.RootElement.GetProperty("successorMachineId").GetString());
        await WithDbAsync(host, async db =>
        {
            Assert.Equal(1, await db.SuccessorReservations.CountAsync());
            var record = await db.SuccessorReservations.SingleAsync();
            Assert.Equal(predecessor.Id, record.PredecessorCabinetId);
            Assert.Equal(machineId, record.SuccessorMachineId);
            Assert.False((await db.Cabinets.SingleAsync(c => c.Id == predecessor.Id)).IsActive);
            Assert.Equal(predecessor.MachineId, (await db.Cabinets.SingleAsync(c => c.Id == predecessor.Id)).MachineId);
            Assert.False(await db.Cabinets.AnyAsync(c => c.MachineId == machineId));
            Assert.False(await db.PendingRegistrations.AnyAsync(c => c.MachineId == machineId));
            return 0;
        });
    }

    [Fact]
    public async Task Reservation_requires_supervisor_and_current_durable_tombstone()
    {
        using var fixture = new ReservationFixture();
        var (host, client, predecessor) = await fixture.CreateAsync();
        string path = $"/api/cabinets/{predecessor.Id}/successor-reservation";
        using var scope = host.Services.CreateScope();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        var hashed = hasher.Hash("Str0ng!TestPassword");
        var tier = new User { Username = Guid.NewGuid().ToString(), DisplayName = "Tier2", Role = Role.Tier2,
            PasswordHash = hashed.Hash, PasswordSalt = hashed.Salt, PasswordIterations = hashed.Iterations,
            IsActive = true, CreatedUtc = DateTimeOffset.UtcNow };
        var userDb = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        userDb.Users.Add(tier);
        await userDb.SaveChangesAsync();
        using var tierClient = host.CreateClient();
        tierClient.DefaultRequestHeaders.Authorization = new("Bearer", scope.ServiceProvider.GetRequiredService<IJwtTokenService>().Issue(tier).AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await tierClient.PostAsync(path, null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.CreateClient().PostAsync(path, null)).StatusCode);
        await WithDbAsync(host, async db => { await db.Cabinets.Where(c => c.Id == predecessor.Id).ExecuteUpdateAsync(s => s.SetProperty(c => c.IsActive, false)); return 0; });
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync(path, null)).StatusCode);
        Assert.Equal(0, await WithDbAsync(host, db => db.SuccessorReservations.CountAsync()));
        // Repair retirement's journal state, then reservation is allowed.
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{predecessor.Id}/retire", new { Reason = "Repair" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(path, null)).StatusCode);
        File.Delete(fixture.StateFile);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync(path, null)).StatusCode);
        Assert.Equal(1, await WithDbAsync(host, db => db.SuccessorReservations.CountAsync()));
    }

    [Fact]
    public async Task Reserved_identity_cannot_enroll_or_enter_agent_registration_queue()
    {
        using var fixture = new ReservationFixture();
        var (host, client, predecessor) = await fixture.CreateAsync();
        await client.PostJsonAsync($"/api/cabinets/{predecessor.Id}/retire", new { Reason = "Synthetic retirement" });
        using var reserved = await client.PostAsync($"/api/cabinets/{predecessor.Id}/successor-reservation", null);
        using var json = JsonDocument.Parse(await reserved.Content.ReadAsStringAsync());
        string machine = json.RootElement.GetProperty("successorMachineId").GetString()!;
        using var agent = host.CreateClient();
        agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", SupportApiFactory.AgentSharedSecret);
        agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", machine);
        using var registration = await agent.PostJsonAsync("/api/agent/register", new
            { MachineId = machine, Hostname = "synthetic", OsVersion = "test", AgentVersion = "test" });
        Assert.Equal(HttpStatusCode.Unauthorized, registration.StatusCode);
        Assert.False(await WithDbAsync(host, db => db.PendingRegistrations.AnyAsync(r => r.MachineId == machine)));
        // An unused configured Office token cannot bind the reserved identity.
        using var enroll = await host.CreateClient().PostJsonAsync("/api/office/enroll", new
            { Token = fixture.SecondToken, MachineId = machine, DeviceKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)) });
        Assert.Equal(HttpStatusCode.Unauthorized, enroll.StatusCode);
    }

    [Fact]
    public async Task Concurrent_retries_share_one_durable_identity_and_audit()
    {
        using var fixture = new ReservationFixture();
        var (host, client, predecessor) = await fixture.CreateAsync();
        await client.PostJsonAsync($"/api/cabinets/{predecessor.Id}/retire", new { Reason = "Synthetic retirement" });
        string path = $"/api/cabinets/{predecessor.Id}/successor-reservation";
        // Separate request contexts race for the same predecessor lock.
        using var otherClient = host.CreateClient();
        otherClient.DefaultRequestHeaders.Authorization = client.DefaultRequestHeaders.Authorization;
        var responses = await Task.WhenAll(client.PostAsync(path, null), otherClient.PostAsync(path, null));
        using var first = responses[0];
        using var second = responses[1];
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(1, await WithDbAsync(host, db => db.SuccessorReservations.CountAsync()));
        Assert.Equal(1, await WithDbAsync(host, db => db.AuditEntries.CountAsync(a => a.Event == CabinetPlatform.Contracts.Audit.AuditEvent.ReserveSuccessorIdentity)));
    }

    [Fact]
    public async Task Database_constraints_reject_duplicate_predecessor_and_successor()
    {
        using var fixture = new ReservationFixture();
        var (host, client, predecessor) = await fixture.CreateAsync();
        await client.PostJsonAsync($"/api/cabinets/{predecessor.Id}/retire", new { Reason = "Synthetic retirement" });
        await client.PostAsync($"/api/cabinets/{predecessor.Id}/successor-reservation", null);
        await WithDbAsync(host, async db =>
        {
            var existing = await db.SuccessorReservations.SingleAsync();
            db.SuccessorReservations.Add(new SuccessorReservation
            {
                PredecessorCabinetId = predecessor.Id, SuccessorMachineId = "successor-duplicate-predecessor",
                ReservedUtc = DateTimeOffset.UtcNow
            });
            await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
            return 0;
        });
        await WithDbAsync(host, async db =>
        {
            var other = new Cabinet { MachineId = "other-" + Guid.NewGuid().ToString("N"), Hostname = "other",
                SiteId = predecessor.SiteId, ApprovedByUserId = predecessor.ApprovedByUserId };
            db.Cabinets.Add(other);
            await db.SaveChangesAsync();
            db.SuccessorReservations.Add(new SuccessorReservation
            {
                PredecessorCabinetId = other.Id, SuccessorMachineId = (await db.SuccessorReservations.SingleAsync()).SuccessorMachineId,
                ReservedUtc = DateTimeOffset.UtcNow
            });
            await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
            return 0;
        });
    }

    [Fact]
    public async Task Disabled_office_mode_never_reserves_even_after_retirement()
    {
        using var host = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(host, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(host, Guid.NewGuid().ToString(), user.Id);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{cabinet.Id}/retire", new { Reason = "Synthetic retirement" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/cabinets/{cabinet.Id}/successor-reservation", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/api/cabinets/{Guid.NewGuid()}/successor-reservation", null)).StatusCode);
        Assert.Equal(0, await host.WithDbAsync(db => db.SuccessorReservations.CountAsync()));
    }

    [Fact]
    public async Task Audit_failure_rolls_back_reservation_without_losing_predecessor()
    {
        using var fixture = new ReservationFixture();
        var (host, client, predecessor) = await fixture.CreateAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{predecessor.Id}/retire", new { Reason = "Synthetic retirement" })).StatusCode);
        await WithDbAsync(host, async db =>
        {
            await db.Database.ExecuteSqlRawAsync("CREATE TRIGGER deny_successor_audit BEFORE INSERT ON AuditEntries WHEN NEW.Event = 145 BEGIN SELECT RAISE(ABORT, 'audit refused'); END");
            return 0;
        });
        using var response = await client.PostAsync($"/api/cabinets/{predecessor.Id}/successor-reservation", null);
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal(0, await WithDbAsync(host, db => db.SuccessorReservations.CountAsync()));
        Assert.Equal(predecessor.MachineId, await WithDbAsync(host, db => db.Cabinets.Where(c => c.Id == predecessor.Id).Select(c => c.MachineId).SingleAsync()));
    }

    private static async Task<T> WithDbAsync<T>(WebApplicationFactory<Program> host, Func<SupportDbContext, Task<T>> work)
    {
        using var scope = host.Services.CreateScope();
        return await work(scope.ServiceProvider.GetRequiredService<SupportDbContext>());
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private sealed class ReservationFixture : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "successor-reservation-" + Guid.NewGuid().ToString("N"));
        public string StateFile => Path.Combine(_root, "journal.json");
        public string SecondToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        private WebApplicationFactory<Program>? _host;
        private readonly SupportApiFactory _baseline = new();
        public ReservationFixture() { Directory.CreateDirectory(_root); File.WriteAllText(StateFile, "[]"); }
        public async Task<(WebApplicationFactory<Program>, HttpClient, Cabinet)> CreateAsync()
        {
            var now = DateTimeOffset.UtcNow;
            string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            string key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            string machine = "office-" + Guid.NewGuid().ToString("N");
            _host = _baseline.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["OfficeEnrollment:Enabled"] = "true", ["OfficeEnrollment:StateFile"] = StateFile,
                    ["OfficeEnrollment:Tokens:0:TokenHash"] = Hash(token),
                    ["OfficeEnrollment:Tokens:0:IssuedUtc"] = now.AddMinutes(-1).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"] = now.AddDays(1).ToString("O"),
                    ["OfficeEnrollment:Tokens:1:TokenHash"] = Hash(SecondToken),
                    ["OfficeEnrollment:Tokens:1:IssuedUtc"] = now.AddMinutes(-1).ToString("O"),
                    ["OfficeEnrollment:Tokens:1:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:1:DeviceExpiresUtc"] = now.AddDays(1).ToString("O")
                })));
            using var anonymous = _host.CreateClient();
            Assert.Equal(HttpStatusCode.NoContent, (await anonymous.PostJsonAsync("/api/office/enroll", new
                { Token = token, MachineId = machine, DeviceKey = key })).StatusCode);
            using var scope = _host.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var user = await db.Users.SingleAsync(u => u.Role == Role.Supervisor);
            user.MustChangePassword = false;
            var cabinet = new Cabinet
            {
                MachineId = machine, Hostname = "synthetic", ApprovedByUserId = user.Id,
                ApprovedUtc = now, Site = new Site { Name = "Synthetic", Client = new Client { Name = "Synthetic" } }
            };
            db.Cabinets.Add(cabinet);
            await db.SaveChangesAsync();
            var client = _host.CreateClient();
            client.DefaultRequestHeaders.Authorization = new("Bearer", scope.ServiceProvider.GetRequiredService<IJwtTokenService>().Issue(user).AccessToken);
            return (_host, client, cabinet);
        }
        public void Dispose() { _host?.Dispose(); _baseline.Dispose(); Directory.Delete(_root, recursive: true); }
    }
}
