using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class OfficeRenewalTests
{
    [Fact]
    public async Task Supervisor_recovers_expired_existing_device_with_idempotent_retry_and_retirement_refusal()
    {
        var root = Path.Combine(Path.GetTempPath(), "office-renewal-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var state = Path.Combine(root, "grants.json");
        await File.WriteAllTextAsync(state, "[]");
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var now = DateTimeOffset.UtcNow.AddDays(-2);
        await File.WriteAllTextAsync(state, System.Text.Json.JsonSerializer.Serialize(new[] {
            new OfficeEnrollmentStore.Grant(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))), "device-one",
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))) }));
        try
        {
            using var factory = new SupportApiFactory();
            using var host = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["OfficeEnrollment:Enabled"] = "true", ["OfficeEnrollment:StateFile"] = state,
                    ["OfficeEnrollment:Tokens:0:TokenHash"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))),
                    ["OfficeEnrollment:Tokens:0:IssuedUtc"] = now.ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"] = now.AddDays(1).ToString("O")
                })));
            using var anonymous = host.CreateClient();
            Guid cabinetId;
            string supervisorToken;
            string tierToken;
            using (var scope = host.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
                var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
                var tokens = scope.ServiceProvider.GetRequiredService<IJwtTokenService>();
                var site = new Site { Name = "Lab", Client = new Client { Name = "Lab client" } };
                var cabinet = new Cabinet { MachineId = "device-one", Hostname = "Lab device", Site = site };
                db.Cabinets.Add(cabinet);
                cabinetId = cabinet.Id;
                User AddUser(Role role)
                {
                    var hash = hasher.Hash("Str0ng!TestPassword");
                    var user = new User { Username = Guid.NewGuid().ToString("N"), DisplayName = "Lab operator", Role = role,
                        PasswordHash = hash.Hash, PasswordSalt = hash.Salt, PasswordIterations = hash.Iterations,
                        IsActive = true, CreatedUtc = DateTimeOffset.UtcNow };
                    db.Users.Add(user);
                    return user;
                }
                var supervisor = AddUser(Role.Supervisor);
                var tier = AddUser(Role.Tier2);
                await db.SaveChangesAsync();
                supervisorToken = tokens.Issue(supervisor).AccessToken;
                tierToken = tokens.Issue(tier).AccessToken;
            }
            using var supervisorClient = host.CreateClient();
            supervisorClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", supervisorToken);
            using var tierClient = host.CreateClient();
            tierClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tierToken);
            using var agent = host.CreateClient();
            agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", "device-one");
            agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", key);
            var path = $"/api/office/enroll/renew/{cabinetId}";
            var request = new { RequestId = Guid.NewGuid(), Reason = "lab repeat" };
            Assert.Equal(HttpStatusCode.Unauthorized, (await agent.GetAsync("/api/agent/actions")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync(path, request)).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await tierClient.PostAsJsonAsync(path, request)).StatusCode);
            var first = await supervisorClient.PostAsJsonAsync(path, request);
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            var firstBody = await first.Content.ReadAsStringAsync();
            var retry = await supervisorClient.PostAsJsonAsync(path, request);
            Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
            Assert.Equal(firstBody, await retry.Content.ReadAsStringAsync());
            Assert.Equal(HttpStatusCode.OK, (await agent.GetAsync("/api/agent/actions")).StatusCode);
            Assert.Equal(HttpStatusCode.Conflict, (await supervisorClient.PostAsJsonAsync($"/api/office/enroll/renew/{Guid.NewGuid()}",
                new { RequestId = Guid.NewGuid(), Reason = "lab repeat" })).StatusCode);
            Assert.Equal(HttpStatusCode.Conflict, (await supervisorClient.PostAsJsonAsync(path,
                new { RequestId = request.RequestId, Reason = "different reason" })).StatusCode);
            using (var scope = host.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
                Assert.True((await db.Cabinets.SingleAsync(c => c.Id == cabinetId)).IsActive);
                Assert.Equal(2, await db.AuditEntries.CountAsync(a => a.CabinetId == cabinetId &&
                    a.Event == CabinetPlatform.Contracts.Audit.AuditEvent.RenewOfficeDevice));
                Assert.Single(System.Text.Json.JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(await File.ReadAllTextAsync(state))![0].Renewals);
                await db.Cabinets.Where(c => c.Id == cabinetId).ExecuteUpdateAsync(s => s.SetProperty(c => c.IsActive, false));
            }
            Assert.Equal(HttpStatusCode.Conflict, (await supervisorClient.PostAsJsonAsync(path,
                new { RequestId = Guid.NewGuid(), Reason = "lab repeat" })).StatusCode);
            Assert.Equal(HttpStatusCode.Conflict, (await supervisorClient.PostAsJsonAsync(path, request)).StatusCode);
            Assert.NotEmpty(firstBody);
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
