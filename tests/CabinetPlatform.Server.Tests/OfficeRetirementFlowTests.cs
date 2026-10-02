using System.Net;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace CabinetPlatform.Server.Tests;

public sealed class OfficeRetirementFlowTests
{
    [Fact]
    public async Task Retirement_shreds_office_key_and_repeat_does_not_duplicate_audit()
    {
        await WithOfficeAsync(async (host, state, machine, key, _) =>
        {
            var (client, id) = await CreateCabinetAsync(host, machine);
            using (client)
            {
                Assert.Equal(HttpStatusCode.NoContent, (await Retire(client, id)).StatusCode);
                Assert.True(await IsRetired(host, id));
                Assert.True(await IsTombstoned(state, machine, key));
                Assert.Equal(HttpStatusCode.NoContent, (await Retire(client, id)).StatusCode);
                Assert.Equal(1, await AuditCount(host, id));
                Assert.True(await IsTombstoned(state, machine, key));
            }
        });
    }

    [Fact]
    public async Task Journal_failure_after_sql_commit_returns_retriable_503_then_retry_shreds_key()
    {
        await WithOfficeAsync(async (host, state, machine, key, token) =>
        {
            var (client, id) = await CreateCabinetAsync(host, machine);
            using (client)
            {
                File.Delete(state);
                using var failure = await Retire(client, id);
                Assert.Equal(HttpStatusCode.ServiceUnavailable, failure.StatusCode);
                string body = await failure.Content.ReadAsStringAsync();
                Assert.DoesNotContain(key, body, StringComparison.Ordinal);
                Assert.DoesNotContain(state, body, StringComparison.Ordinal);
                Assert.DoesNotContain(machine, body, StringComparison.Ordinal);
                Assert.True(await IsRetired(host, id));
                Assert.Equal(1, await AuditCount(host, id));
                await File.WriteAllTextAsync(state, JsonSerializer.Serialize(new[]
                {
                    new OfficeEnrollmentStore.Grant(Hash(token), machine, Hash(key))
                }));
                using var retry = await Retire(client, id);
                Assert.Equal(HttpStatusCode.NoContent, retry.StatusCode);
                Assert.True(await IsTombstoned(state, machine, key));
                Assert.Equal(1, await AuditCount(host, id));
            }
        });
    }

    [Fact]
    public async Task Retirement_without_matching_office_grant_remains_idempotent()
    {
        await WithOfficeAsync(async (host, state, _, _, _) =>
        {
            var (client, id) = await CreateCabinetAsync(host, "ungranted-" + Guid.NewGuid().ToString("N"));
            using (client)
            {
                Assert.Equal(HttpStatusCode.NoContent, (await Retire(client, id)).StatusCode);
                Assert.True(await IsRetired(host, id));
                Assert.Equal(1, await AuditCount(host, id));
                var grant = Assert.Single(JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(await File.ReadAllTextAsync(state))!);
                Assert.False(grant.Revoked);
                Assert.False(grant.KeyDestroyed);
            }
        });
    }

    [Fact]
    public async Task Failed_sql_unit_does_not_shred_office_key()
    {
        var failure = new FailRetirementSave();
        await WithOfficeAsync(async (host, state, machine, key, _) =>
        {
            var (client, id) = await CreateCabinetAsync(host, machine);
            using (client)
            {
                failure.Armed = true;
                Assert.Equal(HttpStatusCode.InternalServerError, (await Retire(client, id)).StatusCode);
                Assert.True(failure.Fired);
                Assert.False(await IsRetired(host, id));
                Assert.Equal(0, await AuditCount(host, id));
                Assert.False(await IsTombstoned(state, machine, key));
                Assert.Equal(HttpStatusCode.NoContent, (await Retire(client, id)).StatusCode);
                Assert.True(await IsTombstoned(state, machine, key));
            }
        }, failure);
    }

    private sealed class FailRetirementSave : SaveChangesInterceptor
    {
        public bool Armed { get; set; }
        public bool Fired { get; private set; }
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            if (Armed && eventData.Context!.ChangeTracker.Entries<AuditEntry>().Any(e => e.Entity.Event == AuditEvent.RetireCabinet))
            {
                Armed = false;
                Fired = true;
                throw new InvalidOperationException("Synthetic SQL unit failure before commit.");
            }
            return ValueTask.FromResult(result);
        }
    }

    private static Task<HttpResponseMessage> Retire(HttpClient client, Guid id) =>
        client.PostJsonAsync($"/api/cabinets/{id}/retire", new { Reason = "Synthetic office retirement" });

    private static async Task<(HttpClient, Guid)> CreateCabinetAsync(WebApplicationFactory<Program> host, string machine)
    {
        using var scope = host.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var user = await db.Users.SingleAsync(u => u.Role == Role.Supervisor);
        user.MustChangePassword = false;
        var cabinet = new Cabinet
        {
            MachineId = machine, Hostname = "synthetic", ApprovedByUserId = user.Id,
            ApprovedUtc = DateTimeOffset.UtcNow,
            Site = new Site { Name = "Synthetic office", Client = new Client { Name = "Synthetic office" } }
        };
        db.Cabinets.Add(cabinet);
        await db.SaveChangesAsync();
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", scope.ServiceProvider.GetRequiredService<IJwtTokenService>().Issue(user).AccessToken);
        return (client, cabinet.Id);
    }

    private static async Task<bool> IsRetired(WebApplicationFactory<Program> host, Guid id)
    {
        using var scope = host.Services.CreateScope();
        return !await scope.ServiceProvider.GetRequiredService<SupportDbContext>().Cabinets.Where(c => c.Id == id).Select(c => c.IsActive).SingleAsync();
    }

    private static async Task<int> AuditCount(WebApplicationFactory<Program> host, Guid id)
    {
        using var scope = host.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<SupportDbContext>().AuditEntries.CountAsync(a => a.CabinetId == id && a.Event == AuditEvent.RetireCabinet);
    }

    private static async Task<bool> IsTombstoned(string state, string machine, string key)
    {
        var grants = JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(await File.ReadAllTextAsync(state))!;
        var grant = Assert.Single(grants, g => g.MachineId == machine);
        return grant.Revoked && grant.KeyDestroyed && grant.KeyHash != Hash(key);
    }

    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    private static async Task WithOfficeAsync(Func<WebApplicationFactory<Program>, string, string, string, string, Task> test,
        FailRetirementSave? failure = null)
    {
        string root = Path.Combine(Path.GetTempPath(), "office-retirement-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string state = Path.Combine(root, "journal.json");
        await File.WriteAllTextAsync(state, "[]");
        string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        string key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        string machine = "office-" + Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        try
        {
            using var baseHost = new SupportApiFactory();
            using var host = baseHost.WithWebHostBuilder(builder =>
            {
                builder.ConfigureAppConfiguration((_, configuration) =>
                    configuration.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["OfficeEnrollment:Enabled"] = "true",
                    ["OfficeEnrollment:StateFile"] = state,
                    ["OfficeEnrollment:Tokens:0:TokenHash"] = Hash(token),
                    ["OfficeEnrollment:Tokens:0:IssuedUtc"] = now.AddMinutes(-1).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"] = now.AddDays(1).ToString("O")
                }));
                if (failure is not null)
                    builder.ConfigureTestServices(services =>
                    {
                        services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
                        services.AddDbContext<SqliteSupportDbContext>((sp, options) => options
                            .UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString).AddInterceptors(failure));
                    });
            });
            using var anonymous = host.CreateClient();
            Assert.Equal(HttpStatusCode.NoContent, (await anonymous.PostJsonAsync("/api/office/enroll", new
            {
                Token = token, MachineId = machine, DeviceKey = key
            })).StatusCode);
            await test(host, state, machine, key, token);
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
