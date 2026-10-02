using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Server.Tests;

public sealed class OfficeRetirementAuthenticationTests
{
    [Fact]
    public async Task Office_agent_authenticates_before_retirement_and_is_unauthorized_after_sql_inactivation()
    {
        await WithOfficeAgentAsync(async (host, agent, machine) =>
        {
            await WithDbAsync(host, async db =>
            {
                db.Cabinets.Add(new Cabinet
                {
                    MachineId = machine, Hostname = "synthetic",
                    Site = new Site { Name = "lab", Client = new Client { Name = "lab" } }
                });
                await db.SaveChangesAsync();
            });
            using (var before = await agent.GetAsync("/api/agent/actions"))
                Assert.Equal(HttpStatusCode.OK, before.StatusCode);
            await WithDbAsync(host, async db =>
            {
                var cabinet = await db.Cabinets.SingleAsync(c => c.MachineId == machine);
                cabinet.IsActive = false;
                await db.SaveChangesAsync();
            });
            using var after = await agent.GetAsync("/api/agent/actions");
            Assert.Equal(HttpStatusCode.Unauthorized, after.StatusCode);
            using var registration = await agent.PostAsJsonAsync("/api/agent/register", new
            {
                MachineId = machine, Hostname = "synthetic", OsVersion = "test", AgentVersion = "test"
            });
            Assert.Equal(HttpStatusCode.Unauthorized, registration.StatusCode);
        });
    }

    [Fact]
    public async Task Office_device_without_approved_cabinet_can_still_register()
    {
        await WithOfficeAgentAsync(async (_, agent, machine) =>
        {
            using var response = await agent.PostAsJsonAsync("/api/agent/register", new
            {
                MachineId = machine, Hostname = "synthetic", OsVersion = "test", AgentVersion = "test"
            });
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        });
    }

    [Fact]
    public async Task Office_agent_is_unauthorized_when_cabinet_sql_query_fails()
    {
        await WithOfficeAgentAsync(async (host, agent, _) =>
        {
            await WithDbAsync(host, db => db.Database.ExecuteSqlRawAsync("DROP TABLE Cabinets"));
            using var response = await agent.GetAsync("/api/agent/actions");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        });
    }

    [Fact]
    public async Task Legacy_shared_secret_still_reaches_agent_route_without_a_cabinet()
    {
        using var host = new SupportApiFactory();
        using var agent = TestClient.CreateAgentClient(host, "legacy-unregistered");
        using var response = await agent.GetAsync("/api/agent/actions");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    private static async Task WithDbAsync(WebApplicationFactory<Program> host, Func<SupportDbContext, Task> work)
    {
        using var scope = host.Services.CreateScope();
        await work(scope.ServiceProvider.GetRequiredService<SupportDbContext>());
    }

    private static async Task WithOfficeAgentAsync(Func<WebApplicationFactory<Program>, HttpClient, string, Task> test)
    {
        var root = Path.Combine(Path.GetTempPath(), "office-auth-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var state = Path.Combine(root, "grants.json");
        await File.WriteAllTextAsync(state, "[]");
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var machine = "office-" + Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        try
        {
            using var factory = new SupportApiFactory();
            using var host = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["OfficeEnrollment:Enabled"] = "true",
                    ["OfficeEnrollment:StateFile"] = state,
                    ["OfficeEnrollment:Tokens:0:TokenHash"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))),
                    ["OfficeEnrollment:Tokens:0:IssuedUtc"] = now.AddMinutes(-1).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"] = now.AddDays(1).ToString("O")
                })));
            using var agent = host.CreateClient();
            using (var enrollment = await agent.PostAsJsonAsync("/api/office/enroll", new
            {
                Token = token, MachineId = machine, DeviceKey = key
            })) Assert.Equal(HttpStatusCode.NoContent, enrollment.StatusCode);
            agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", key);
            agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", machine);
            await test(host, agent, machine);
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
