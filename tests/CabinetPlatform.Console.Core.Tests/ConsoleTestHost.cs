using System.Data.Common;
using System.Text.Json;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// Hosts the real server in-process and hands the console's real
/// <see cref="ApiClient"/> an <see cref="HttpClient"/> pointed at it.
/// </summary>
/// <remarks>
/// <para>
/// The console is a client of one server, so the only test worth much is one
/// that talks to that server. A hand-rolled fake HTTP handler would assert that
/// the client agrees with whatever I believed the server did while writing it,
/// which is exactly the belief most likely to be wrong.
/// </para>
/// <para>
/// This runs the real pipeline: the real authorization policies, the real
/// four-eyes check, the real 403 wording that the login screen has to tell apart
/// from a lockout. Every unhappy path the console claims to handle is provoked
/// here by the server itself rather than simulated.
/// </para>
/// </remarks>
public sealed class ConsoleTestHost : WebApplicationFactory<Server.Controllers.AgentController>
{
    public const string KnownPassword = "Str0ng!TestPassword";

    private DbConnection? _connection;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureAppConfiguration(configuration =>
            configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SigningKey"] = "console-integration-test-signing-key-at-least-32-bytes",
                ["Jwt:TokenLifetimeMinutes"] = "30",
                ["AgentAuth:SharedSecret"] = "console-test-agent-secret",
                ["Seed:SupervisorUsername"] = "seed-supervisor",
                ["Seed:SupervisorInitialPassword"] = "Seeded!Supervisor1",
                ["Password:Iterations"] = "100000",
                ["Retention:Enabled"] = "false",
                ["Actions:ExpirySweepIntervalSeconds"] = "3600",

                // The console's tests sign in repeatedly; the limiter is the
                // server's own test subject, not this suite's.
                ["LoginSecurity:RateLimitPermitPerWindow"] = "1000"
            }));

        builder.ConfigureServices(services =>
        {
            services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            services.RemoveAll<DbContextOptions<SupportDbContext>>();
            services.RemoveAll<SupportDbContext>();
            services.RemoveAll<DbConnection>();

            // A shared-cache in-memory database named uniquely per fixture, so
            // every context opens its own connection and SQLite serialises them
            // itself. One connection shared across concurrent requests produces
            // an intermittent "SQL logic error" that reads as a product fault
            // and is not one.
            string name = $"console-tests-{Guid.NewGuid():N}";
            var connectionString = $"DataSource=file:{name}?mode=memory&cache=shared";

            _connection = new SqliteConnection(connectionString);
            _connection.Open();

            services.AddSingleton(_connection);
            services.AddDbContext<SqliteSupportDbContext>(options => options.UseSqlite(connectionString));
            services.AddScoped<SupportDbContext>(sp => sp.GetRequiredService<SqliteSupportDbContext>());

            services.RemoveAll<IHostedService>();
        });
    }

    /// <summary>
    /// A console API client wired exactly as the application wires it: the same
    /// bearer handler, the same session store, the same JSON convention.
    /// </summary>
    public (ApiClient Api, SessionStore Session) CreateConsole()
    {
        var session = new SessionStore();

        HttpClient inner = CreateDefaultClient(new BearerTokenHandler(session)
        {
            InnerHandler = Server.CreateHandler()
        });

        return (new ApiClient(inner, session), session);
    }

    public async Task<User> CreateUserAsync(
        Role role,
        string username,
        bool mustChangePassword = false,
        bool isActive = true,
        string password = KnownPassword)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();

        PasswordHashResult hashed = hasher.Hash(password);

        var user = new User
        {
            Username = username,
            DisplayName = $"{username} display",
            Role = role,
            PasswordHash = hashed.Hash,
            PasswordSalt = hashed.Salt,
            PasswordIterations = hashed.Iterations,
            IsActive = isActive,
            MustChangePassword = mustChangePassword,
            CreatedUtc = DateTimeOffset.UtcNow
        };

        db.Users.Add(user);
        await db.SaveChangesAsync();

        return user;
    }

    /// <summary>
    /// Creates a cabinet, together with the client and site it hangs off.
    /// </summary>
    /// <remarks>
    /// Client and site are rows rather than strings on the cabinet because the
    /// client is a security boundary: a cabinet-to-cabinet probe may not cross
    /// it. Two cabinets that are meant to be on one network therefore have to be
    /// created with the same client and site names.
    /// </remarks>
    public async Task<Cabinet> CreateCabinetAsync(
        string hostname,
        string client = "Northgate Veterinary",
        string site = "Main Surgery",
        string? department = "Pharmacy",
        bool isActive = true,
        DateTimeOffset? lastCheckInUtc = null,
        CabinetRole role = CabinetRole.Standalone,
        string? timeZoneId = null)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        Site resolved = await ResolveSiteAsync(db, client, site);

        var cabinet = new Cabinet
        {
            MachineId = $"machine-{Guid.NewGuid():N}",
            Hostname = hostname,
            SiteId = resolved.Id,
            DepartmentName = department,
            Role = role,
            TimeZoneId = timeZoneId,
            Model = "CUBEX MedBank 2",
            SerialNumber = $"SN{Random.Shared.Next(100000, 999999)}",
            ApprovedUtc = DateTimeOffset.UtcNow.AddDays(-30),
            ApprovedByUserId = Guid.NewGuid(),
            IsActive = isActive,
            LastCheckInUtc = lastCheckInUtc,
            AgentVersion = "1.4.2"
        };

        db.Cabinets.Add(cabinet);
        await db.SaveChangesAsync();

        if (role == CabinetRole.Sync && resolved.SyncCabinetId is null)
        {
            // Written after the cabinet exists: a site points at its sync
            // cabinet and that cabinet points back at its site, which is a
            // circular foreign key if both go in one batch.
            resolved.SyncCabinetId = cabinet.Id;
            await db.SaveChangesAsync();
        }

        return cabinet;
    }

    /// <summary>Finds or creates the client and site a cabinet belongs to.</summary>
    private static async Task<Site> ResolveSiteAsync(
        SupportDbContext db, string clientName, string siteName)
    {
        Client? client = await db.Clients.FirstOrDefaultAsync(c => c.Name == clientName);

        if (client is null)
        {
            client = new Client { Name = clientName };
            db.Clients.Add(client);
            await db.SaveChangesAsync();
        }

        Site? site = await db.Sites
            .FirstOrDefaultAsync(s => s.ClientId == client.Id && s.Name == siteName);

        if (site is null)
        {
            site = new Site { ClientId = client.Id, Name = siteName };
            db.Sites.Add(site);
            await db.SaveChangesAsync();
        }

        return site;
    }

    /// <summary>
    /// Writes a heartbeat exactly as the ingest path would: the typed columns
    /// the list views read, and no payload document.
    /// </summary>
    /// <remarks>
    /// A heartbeat carries no JSON blob by design — seven thousand cabinets at a
    /// five-minute cadence is two million rows a day, and no list or aggregate
    /// query in the server reads anything but these columns. Inventory travels
    /// on the full tier instead, through <see cref="AddInventoryAsync"/>.
    /// </remarks>
    public async Task<Heartbeat> AddHeartbeatAsync(
        Guid cabinetId,
        CheckInPayload payload,
        DateTimeOffset receivedUtc,
        double minFreeDiskPercent = 42d,
        DiskHealthStatus worstDiskHealth = DiskHealthStatus.Healthy)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        var heartbeat = new Heartbeat
        {
            CabinetId = cabinetId,
            ReceivedUtc = receivedUtc,
            CollectedAtUtc = payload.CollectedAtUtc,
            AgentVersion = payload.AgentVersion,
            CpuPercent = payload.Performance?.CpuTotalPercent,
            RamUsedPercent = payload.Performance?.RamUsedPercent,
            MinFreeDiskPercent = minFreeDiskPercent,
            PendingUpdateCount = payload.WindowsUpdate?.PendingUpdateCount,
            RebootPending = payload.WindowsUpdate?.RebootPending,
            WorstDiskHealth = worstDiskHealth,
            AnyUserLoggedOn = payload.System?.AnyUserLoggedOn,
            UptimeSeconds = payload.System?.Uptime?.TotalSeconds,
            SectionErrorsJson = JsonSerializer.Serialize(
                payload.SectionErrors, Contracts.Common.ContractJson.Default),
        };

        db.Heartbeats.Add(heartbeat);

        Cabinet? cabinet = await db.Cabinets.FirstOrDefaultAsync(c => c.Id == cabinetId);

        if (cabinet is not null)
        {
            cabinet.LastCheckInUtc = receivedUtc;
            cabinet.AgentVersion = payload.AgentVersion;

            // Mirrors the ingest path: the cabinet's own zone comes from what
            // the agent reported, and is what every maintenance window and
            // scheduled install is evaluated against.
            cabinet.TimeZoneId = payload.System?.TimeZoneId ?? cabinet.TimeZoneId;
        }

        await db.SaveChangesAsync();

        return heartbeat;
    }

    /// <summary>
    /// Stores one inventory version, the way a full-tier check-in whose content
    /// hash had changed would.
    /// </summary>
    public async Task<InventoryVersion> AddInventoryAsync(
        Guid cabinetId, CheckInPayload payload, DateTimeOffset observedUtc)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        var version = new InventoryVersion
        {
            CabinetId = cabinetId,
            ContentHash = Guid.NewGuid().ToString("N"),
            FirstObservedUtc = observedUtc,
            LastObservedUtc = observedUtc,
            PayloadJson = JsonSerializer.Serialize(payload, Contracts.Common.ContractJson.Default),
            SectionErrorsJson = JsonSerializer.Serialize(
                payload.SectionErrors, Contracts.Common.ContractJson.Default),
        };

        db.InventoryVersions.Add(version);

        Cabinet? cabinet = await db.Cabinets.FirstOrDefaultAsync(c => c.Id == cabinetId);

        if (cabinet is not null)
        {
            cabinet.CurrentInventoryVersionId = version.Id;
            cabinet.LastFullCheckInUtc = observedUtc;
        }

        await db.SaveChangesAsync();

        return version;
    }

    /// <summary>
    /// Stores one cabinet's full-tier check-in: the heartbeat projection and the
    /// inventory version together.
    /// </summary>
    /// <remarks>
    /// This is what most of the console's tests want, because the machine tab
    /// reads both: the header comes from the latest heartbeat and every section
    /// below it from the inventory in force. Splitting them is still possible
    /// where a test needs a cabinet that has only heartbeated.
    /// </remarks>
    public async Task<Heartbeat> AddFullCheckInAsync(
        Guid cabinetId,
        CheckInPayload payload,
        DateTimeOffset receivedUtc,
        double minFreeDiskPercent = 42d,
        DiskHealthStatus worstDiskHealth = DiskHealthStatus.Healthy)
    {
        Heartbeat heartbeat = await AddHeartbeatAsync(
            cabinetId, payload, receivedUtc, minFreeDiskPercent, worstDiskHealth);

        await AddInventoryAsync(cabinetId, payload, receivedUtc);

        return heartbeat;
    }

    public async Task AddSmartReadingsAsync(Guid cabinetId, IEnumerable<SmartReading> readings)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        foreach (SmartReading reading in readings)
        {
            reading.CabinetId = cabinetId;
            db.SmartReadings.Add(reading);
        }

        await db.SaveChangesAsync();
    }

    public async Task<T> WithDbAsync<T>(Func<SupportDbContext, Task<T>> work)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        return await work(db);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);

        if (disposing)
        {
            _connection?.Dispose();
            _connection = null;
        }
    }
}
