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

public sealed class SuccessorPreparationTests
{
    [Fact]
    public async Task Only_supervisors_can_read_predecessor_preparation_evidence()
    {
        using var host = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(host, Role.Tier2, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(host, Guid.NewGuid().ToString(), user.Id);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await client.GetAsync($"/api/cabinets/{cabinet.Id}/successor-preparation")).StatusCode);
    }

    [Fact]
    public async Task Disabled_office_mode_never_claims_preparation_even_for_retired_cabinet()
    {
        using var host = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(host, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(host, Guid.NewGuid().ToString(), user.Id);
        Assert.Equal(HttpStatusCode.Conflict,
            (await client.GetAsync($"/api/cabinets/{cabinet.Id}/successor-preparation")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await client.PostJsonAsync($"/api/cabinets/{cabinet.Id}/retire", new { Reason = "Synthetic retirement" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict,
            (await client.GetAsync($"/api/cabinets/{cabinet.Id}/successor-preparation")).StatusCode);
    }

    [Fact]
    public async Task Office_preparation_requires_retirement_and_durable_tombstone_and_is_not_a_credential()
    {
        string root = Path.Combine(Path.GetTempPath(), "successor-preparation-" + Guid.NewGuid().ToString("N"));
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
            using var host = baseHost.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["OfficeEnrollment:Enabled"] = "true", ["OfficeEnrollment:StateFile"] = state,
                    ["OfficeEnrollment:Tokens:0:TokenHash"] = Hash(token),
                    ["OfficeEnrollment:Tokens:0:IssuedUtc"] = now.AddMinutes(-1).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"] = now.AddDays(1).ToString("O")
                })));
            using var anonymous = host.CreateClient();
            Assert.Equal(HttpStatusCode.NoContent, (await anonymous.PostJsonAsync("/api/office/enroll", new
                { Token = token, MachineId = machine, DeviceKey = key })).StatusCode);
            using var scope = host.Services.CreateScope();
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
            using var client = host.CreateClient();
            client.DefaultRequestHeaders.Authorization = new("Bearer", scope.ServiceProvider.GetRequiredService<IJwtTokenService>().Issue(user).AccessToken);
            string path = $"/api/cabinets/{cabinet.Id}/successor-preparation";
            Assert.Equal(HttpStatusCode.Conflict, (await client.GetAsync(path)).StatusCode);
            Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{cabinet.Id}/retire", new { Reason = "Synthetic retirement" })).StatusCode);
            using var ready = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, ready.StatusCode);
            using var document = JsonDocument.Parse(await ready.Content.ReadAsStringAsync());
            Assert.Equal(cabinet.Id, document.RootElement.GetProperty("predecessorCabinetId").GetGuid());
            Assert.True(document.RootElement.GetProperty("preparationOnly").GetBoolean());
            Assert.False(document.RootElement.TryGetProperty("deviceKey", out _));
            Assert.False(document.RootElement.TryGetProperty("token", out _));
            Assert.DoesNotContain(key, document.RootElement.ToString(), StringComparison.Ordinal);
            // The live journal must be read back, not a cached successful Revoke result.
            File.Delete(state);
            Assert.Equal(HttpStatusCode.Conflict, (await client.GetAsync(path)).StatusCode);
            await File.WriteAllTextAsync(state, JsonSerializer.Serialize(new[]
                { new OfficeEnrollmentStore.Grant(Hash(token), machine, Hash(key)) }));
            Assert.Equal(HttpStatusCode.Conflict, (await client.GetAsync(path)).StatusCode);
            await File.WriteAllTextAsync(state, "not-json");
            Assert.Equal(HttpStatusCode.Conflict, (await client.GetAsync(path)).StatusCode);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
