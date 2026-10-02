using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace CabinetPlatform.Server.Tests;

public sealed class OfficeRetirementReconciliationTests
{
    [Fact]
    public async Task Restart_tombstones_committed_inactive_grant_without_touching_active_or_pending()
    {
        using var fixture = new OfficeFixture();
        using (var host = fixture.Start())
        {
            using var scope = host.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            Assert.Equal(fixture.DatabasePath, db.Database.GetDbConnection().DataSource);
            var site = new Site { Name = "Reconciliation site", Client = new Client { Name = "Reconciliation client" } };
            db.Cabinets.AddRange(
                new Cabinet { MachineId = "reconcile-retired", Hostname = "Retired", Site = site, IsActive = false },
                new Cabinet { MachineId = "reconcile-active", Hostname = "Active", Site = site });
            db.PendingRegistrations.Add(new PendingRegistration { MachineId = "reconcile-pending", Hostname = "Pending" });
            await db.SaveChangesAsync();
        }
        fixture.WriteGrants("reconcile-retired", "reconcile-active", "reconcile-pending");
        using (var host = fixture.Start())
        {
            using var scope = host.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            Assert.False(await db.Cabinets.Where(c => c.MachineId == "reconcile-retired").Select(c => c.IsActive).SingleAsync());
            Assert.True(await db.Cabinets.Where(c => c.MachineId == "reconcile-active").Select(c => c.IsActive).SingleAsync());
            Assert.NotNull(await db.PendingRegistrations.SingleAsync(p => p.MachineId == "reconcile-pending"));
            var grants = fixture.ReadGrants();
            Assert.True(grants["reconcile-retired"].Revoked);
            Assert.True(grants["reconcile-retired"].KeyDestroyed);
            Assert.False(grants["reconcile-active"].Revoked);
            Assert.False(grants["reconcile-pending"].Revoked);
        }
        // A second restart must preserve the tombstone and active credentials.
        using (var host = fixture.Start())
        {
            Assert.True(fixture.ReadGrants()["reconcile-retired"].KeyDestroyed);
            Assert.False(fixture.ReadGrants()["reconcile-active"].Revoked);
        }
    }

    [Fact]
    public async Task Journal_write_failure_refuses_start_and_preserves_live_grant()
    {
        if (OperatingSystem.IsWindows()) return; // Unix directory permissions exercise the write failure.
        using var fixture = new OfficeFixture();
        await fixture.AddInactiveCabinetAsync("reconcile-retired");
        fixture.WriteGrants("reconcile-retired");
        var original = File.ReadAllText(fixture.JournalPath);
        File.SetUnixFileMode(fixture.JournalDirectory, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            var failure = Assert.ThrowsAny<Exception>(() => fixture.Start());
            Assert.Contains("Persist", failure.ToString(), StringComparison.Ordinal);
            Assert.Equal(original, File.ReadAllText(fixture.JournalPath));
            Assert.False(fixture.ReadGrants()["reconcile-retired"].Revoked);
        }
        finally { File.SetUnixFileMode(fixture.JournalDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); }
    }

    [Fact]
    public async Task Unavailable_sql_refuses_start_without_changing_journal()
    {
        using var fixture = new OfficeFixture();
        await fixture.AddInactiveCabinetAsync("reconcile-retired");
        fixture.WriteGrants("reconcile-retired");
        var original = File.ReadAllText(fixture.JournalPath);
        File.Delete(fixture.DatabasePath);
        Directory.CreateDirectory(fixture.DatabasePath);
        Assert.ThrowsAny<Exception>(() => fixture.Start());
        Assert.Equal(original, File.ReadAllText(fixture.JournalPath));
    }

    [Fact]
    public async Task Reconciliation_reaches_inactive_grant_beyond_first_page()
    {
        using var fixture = new OfficeFixture();
        string lastMachineId;
        using (var host = fixture.Start())
        {
            using var scope = host.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var site = new Site { Name = "Paged site", Client = new Client { Name = "Paged client" } };
            db.Cabinets.AddRange(Enumerable.Range(0, 260).Select(i => new Cabinet
            {
                MachineId = $"paged-{i}", Hostname = $"Paged-{i}", Site = site, IsActive = false
            }));
            await db.SaveChangesAsync();
            lastMachineId = await db.Cabinets.AsNoTracking().Where(c => !c.IsActive)
                .OrderBy(c => c.Id).Select(c => c.MachineId).LastAsync();
        }
        fixture.WriteGrants(lastMachineId);
        using var restarted = fixture.Start();
        Assert.True(fixture.ReadGrants()[lastMachineId].KeyDestroyed);
    }

    private sealed class OfficeFixture : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "office-reconcile-" + Guid.NewGuid().ToString("N"));
        private readonly string[] _tokens = Enumerable.Range(0, 3)
            .Select(_ => Convert.ToHexString(RandomNumberGenerator.GetBytes(32))).ToArray();
        private readonly DateTimeOffset _now = DateTimeOffset.UtcNow;
        public string DatabasePath => DbPath;
        public string JournalDirectory => Path.Combine(_root, "journal");
        private string DbPath => Path.Combine(_root, "office.db");
        public string JournalPath => Path.Combine(JournalDirectory, "grants.json");

        public OfficeFixture()
        {
            Directory.CreateDirectory(_root);
            Directory.CreateDirectory(JournalDirectory);
            File.WriteAllText(JournalPath, "[]");
        }

        public async Task AddInactiveCabinetAsync(string machineId)
        {
            using var host = Start();
            using var scope = host.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            db.Cabinets.Add(new Cabinet { MachineId = machineId, Hostname = "Retired",
                IsActive = false, Site = new Site { Name = "Reconciliation site", Client = new Client { Name = "Reconciliation client" } } });
            await db.SaveChangesAsync();
        }

        public Dictionary<string, OfficeEnrollmentStore.Grant> ReadGrants() =>
            JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(File.ReadAllText(JournalPath))!
                .ToDictionary(g => g.MachineId);

        public void WriteGrants(params string[] ids)
        {
            var grants = ids.Select((id, index) => new OfficeEnrollmentStore.Grant(Hash(_tokens[index]), id,
                Hash(Convert.ToHexString(RandomNumberGenerator.GetBytes(32))))).ToList();
            File.WriteAllText(JournalPath, JsonSerializer.Serialize(grants));
        }

        public WebApplicationFactory<Program> Start()
        {
            var host = new OfficeFactory(DbPath, JournalPath, _tokens.Select(Hash).ToArray(), _now);
            try
            {
                _ = host.CreateClient();
                return host;
            }
            catch
            {
                host.Dispose();
                throw;
            }
        }

        public void Dispose() => Directory.Delete(_root, recursive: true);
        private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }

    private sealed class OfficeFactory(string dbPath, string journalPath, string[] tokenHashes, DateTimeOffset now)
        : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Testing");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
                services.AddDbContext<SqliteSupportDbContext>(options => options.UseSqlite($"Data Source={dbPath}"));
            });
            builder.ConfigureAppConfiguration((_, configuration) =>
            {
                var values = new Dictionary<string, string?>
                {
                    ["Database:Provider"] = "Sqlite",
                    ["ConnectionStrings:SupportDatabase"] = $"Data Source={dbPath}",
                    ["OfficeEnrollment:Enabled"] = "true",
                    ["OfficeEnrollment:StateFile"] = journalPath,
                    ["Seed:SupervisorUsername"] = "supervisor",
                    ["Seed:SupervisorInitialPassword"] = "Seeded!Supervisor1",
                    ["Password:Iterations"] = "100000",
                    ["Jwt:SigningKey"] = "integration-test-signing-key-at-least-32-bytes-long",
                    ["AgentAuth:SharedSecret"] = SupportApiFactory.AgentSharedSecret,
                    ["Retention:Enabled"] = "false"
                };
                for (var i = 0; i < tokenHashes.Length; i++)
                {
                    values[$"OfficeEnrollment:Tokens:{i}:TokenHash"] = tokenHashes[i];
                    values[$"OfficeEnrollment:Tokens:{i}:IssuedUtc"] = now.AddMinutes(-1).ToString("O");
                    values[$"OfficeEnrollment:Tokens:{i}:ExpiresUtc"] = now.AddMinutes(20).ToString("O");
                    values[$"OfficeEnrollment:Tokens:{i}:DeviceExpiresUtc"] = now.AddDays(1).ToString("O");
                }
                configuration.AddInMemoryCollection(values);
            });
        }
    }
}
