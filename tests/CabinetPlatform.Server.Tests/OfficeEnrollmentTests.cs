using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Server.Tests;

public sealed class OfficeEnrollmentTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Fresh_token_cannot_take_over_a_legacy_registration_or_approved_cabinet(bool approved)
    {
        var root = Path.Combine(Path.GetTempPath(), "office-collision-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var now = DateTimeOffset.UtcNow;
        await File.WriteAllTextAsync(Path.Combine(root, "grants.json"), "[]");
        await File.WriteAllTextAsync(Path.Combine(root, "office-enrollment.json"), System.Text.Json.JsonSerializer.Serialize(new
        {
            OfficeEnrollment = new { Enabled = true, StateFile = Path.Combine(root, "grants.json"), Tokens = new[] {
                new { TokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))), IssuedUtc = now,
                    ExpiresUtc = now.AddMinutes(20), DeviceExpiresUtc = now.AddDays(1) } } }
        }));
        try
        {
            using var factory = new SupportApiFactory();
            using var host = factory.WithWebHostBuilder(builder => builder.UseContentRoot(root));
            using var client = host.CreateClient();
            using (var scope = host.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
                if (approved)
                    db.Cabinets.Add(new Cabinet
                    {
                        MachineId = "legacy-device", Hostname = "Legacy",
                        Site = new Site { Name = "Legacy site", Client = new Client { Name = "Legacy client" } }
                    });
                else
                    db.PendingRegistrations.Add(new PendingRegistration { MachineId = "legacy-device", Hostname = "Legacy" });
                await db.SaveChangesAsync();
            }
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/office/enroll", new
            {
                Token = token, MachineId = "legacy-device", DeviceKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32))
            })).StatusCode);
            Assert.Equal("[]", await File.ReadAllTextAsync(Path.Combine(root, "grants.json")));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task Companion_manifest_activates_office_auth_without_individual_environment_token_edits()
    {
        var root = Path.Combine(Path.GetTempPath(), "office-manifest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, "grants.json"), "[]");
        await File.WriteAllTextAsync(Path.Combine(root, "office-enrollment.json"), System.Text.Json.JsonSerializer.Serialize(new
        {
            OfficeEnrollment = new { Enabled = true, StateFile = Path.Combine(root, "grants.json"), Tokens = Array.Empty<object>() }
        }));
        try
        {
            using var factory = new SupportApiFactory();
            using var host = factory.WithWebHostBuilder(builder => builder.UseContentRoot(root));
            using var client = host.CreateClient();
            client.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", SupportApiFactory.AgentSharedSecret);
            client.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", "unknown");
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/agent/actions")).StatusCode);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void Missing_office_journal_prevents_host_start_instead_of_a_healthy_but_unsafe_server()
    {
        using var factory = new SupportApiFactory();
        using var host = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["OfficeEnrollment:Enabled"] = "true",
                ["OfficeEnrollment:StateFile"] = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "missing.json"),
            })));
        Assert.ThrowsAny<Exception>(() => host.CreateClient());
    }

    [Fact]
    public async Task Enrollment_rate_limit_cannot_be_bypassed_by_changing_claimed_machine_header()
    {
        using var factory = new SupportApiFactory();
        using var client = factory.CreateClient();
        HttpResponseMessage? last = null;
        for (var i = 0; i < 21; i++)
        {
            client.DefaultRequestHeaders.Remove("X-Mashura-Machine-Id");
            client.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", "attacker-" + i);
            last?.Dispose();
            last = await client.PostAsJsonAsync("/api/office/enroll", new
            {
                Token = new string('A', 64), MachineId = "attacker-" + i, DeviceKey = new string('B', 64)
            });
        }
        using (last) Assert.Equal(HttpStatusCode.TooManyRequests, last!.StatusCode);
    }

    [Fact]
    public async Task Unique_token_binds_one_device_and_never_accepts_shared_fleet_key()
    {
        var directory = Path.Combine(Path.GetTempPath(), "office-enrollment-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var state = Path.Combine(directory, "grants.json");
        await File.WriteAllTextAsync(state, "[]");
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var otherKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
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
                    ["OfficeEnrollment:Tokens:0:IssuedUtc"] = now.ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"] = now.AddDays(1).ToString("O"),
                })));
            using var client = host.CreateClient();
            var request = new { Token = token, MachineId = "office-a", DeviceKey = key };
            Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/office/enroll", request)).StatusCode);
            // A lost response can be retried with exactly the persisted local identity/key.
            Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/office/enroll", request)).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/office/enroll",
                new { Token = token, MachineId = "office-b", DeviceKey = otherKey })).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/office/enroll",
                new { Token = token, MachineId = "office-a", DeviceKey = otherKey })).StatusCode);
            client.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", key);
            client.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", "office-a");
            var registration = new { MachineId = "office-a", Hostname = "LAB-A", OsVersion = "test", AgentVersion = "test" };
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/agent/register", registration)).StatusCode);
            // Unique credential does not imply supervisor approval.
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/agent/actions")).StatusCode);
            client.DefaultRequestHeaders.Remove("X-Mashura-Machine-Id");
            client.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", "office-b");
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/agent/actions")).StatusCode);
            client.DefaultRequestHeaders.Remove("X-Mashura-Agent-Key");
            client.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", SupportApiFactory.AgentSharedSecret);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/agent/actions")).StatusCode);
            var persisted = await File.ReadAllTextAsync(state);
            Assert.DoesNotContain(token, persisted);
            Assert.DoesNotContain(key, persisted);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}
