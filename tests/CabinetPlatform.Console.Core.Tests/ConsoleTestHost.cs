using System.Data.Common;
using System.Text.Json;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Contracts.Agent;
using CabinetPlatform.Contracts.Enums;
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
public sealed class ConsoleTestHost : WebApplicationFactory<Program>
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
            services.RemoveAll<DbContextOptions<SupportDbContext>>();
            services.RemoveAll<DbConnection>();

            _connection = new SqliteConnection("DataSource=:memory:");
            _connection.Open();

            services.AddSingleton(_connection);
            services.AddDbContext<SupportDbContext>((sp, options) =>
                options.UseSqlite(sp.GetRequiredService<DbConnection>()));

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
        UserRole role,
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
            CreatedUtc = DateTime.UtcNow
        };

        db.Users.Add(user);
        await db.SaveChangesAsync();

        return user;
    }

    public async Task<Cabinet> CreateCabinetAsync(
        string hostname,
        string client = "Northgate Veterinary",
        string site = "Main Surgery",
        string? department = "Pharmacy",
        bool isActive = true,
        DateTime? lastCheckInUtc = null)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        var cabinet = new Cabinet
        {
            MachineId = $"machine-{Guid.NewGuid():N}",
            Hostname = hostname,
            ClientName = client,
            SiteName = site,
            DepartmentName = department,
            Model = "CUBEX MedBank 2",
            SerialNumber = $"SN{Random.Shared.Next(100000, 999999)}",
            ApprovedUtc = DateTime.UtcNow.AddDays(-30),
            ApprovedByUserId = Guid.NewGuid(),
            IsActive = isActive,
            LastCheckInUtc = lastCheckInUtc,
            AgentVersion = "1.4.2"
        };

        db.Cabinets.Add(cabinet);
        await db.SaveChangesAsync();

        return cabinet;
    }

    /// <summary>
    /// Writes a check-in exactly as the ingest path would: the verbatim payload
    /// JSON plus the projected columns the list views read.
    /// </summary>
    public async Task<CheckIn> AddCheckInAsync(
        Guid cabinetId,
        CheckInRequest payload,
        DateTime receivedUtc,
        double minFreeDiskPercent = 42d,
        DiskHealthStatus worstDiskHealth = DiskHealthStatus.Healthy)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        var checkIn = new CheckIn
        {
            CabinetId = cabinetId,
            ReceivedUtc = receivedUtc,
            CollectedAtUtc = payload.CollectedAtUtc,
            PayloadJson = JsonSerializer.Serialize(
                payload, Contracts.Common.ContractJson.Default),
            CpuPercent = payload.CpuPercent,
            RamUsedPercent = payload.RamUsedPercent,
            MinFreeDiskPercent = minFreeDiskPercent,
            PendingUpdateCount = payload.PendingUpdates.Count,
            WorstDiskHealth = worstDiskHealth,
            AnyUserLoggedOn = payload.AnyUserLoggedOn
        };

        db.CheckIns.Add(checkIn);

        Cabinet? cabinet = await db.Cabinets.FirstOrDefaultAsync(c => c.Id == cabinetId);

        if (cabinet is not null)
        {
            cabinet.LastCheckInUtc = receivedUtc;
            cabinet.AgentVersion = payload.AgentVersion ?? cabinet.AgentVersion;
        }

        await db.SaveChangesAsync();

        return checkIn;
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
