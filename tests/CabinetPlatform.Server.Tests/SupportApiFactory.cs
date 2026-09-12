using System.Data.Common;
using CabinetPlatform.Server.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// Hosts the real application — the real pipeline, the real policies, the real
/// authorization handlers — against an in-memory SQLite database.
///
/// The point of hosting the actual <c>Program</c> rather than a reconstruction
/// is that a test asserting "every endpoint has a policy" is worthless if it
/// asserts it about a second, tidier wiring that only the tests use.
/// </summary>
public sealed class SupportApiFactory : WebApplicationFactory<Program>
{
    public const string AgentSharedSecret = "test-agent-shared-secret-value";
    public const string SeedSupervisorUsername = "supervisor";
    public const string SeedSupervisorPassword = "Seeded!Supervisor1";

    private DbConnection? _connection;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureAppConfiguration(configuration =>
        {
            configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                // Test-only values. The repository contains no usable secret;
                // these exist solely so the host can start under xunit.
                ["Jwt:SigningKey"] = "integration-test-signing-key-at-least-32-bytes-long",
                ["Jwt:TokenLifetimeMinutes"] = "30",
                ["AgentAuth:SharedSecret"] = AgentSharedSecret,
                ["Seed:SupervisorUsername"] = SeedSupervisorUsername,
                ["Seed:SupervisorInitialPassword"] = SeedSupervisorPassword,

                // The minimum the hasher will accept. Real deployments use the
                // configured 210k; 100k keeps a suite of logins tolerable.
                ["Password:Iterations"] = "100000",

                // Sweeps are driven explicitly in the tests that want them.
                ["Retention:Enabled"] = "false",
                ["Actions:ExpirySweepIntervalSeconds"] = "3600",

                // Wide enough that ordinary tests never trip the limiter; the
                // limiter itself is exercised deliberately where it matters.
                ["LoginSecurity:RateLimitPermitPerWindow"] = "1000",
                ["AgentIngest:RegisterPermitPerWindow"] = "1000",
                ["AgentIngest:CheckInPermitPerWindow"] = "1000"
            });
        });

        builder.ConfigureServices(services =>
        {
            services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            services.RemoveAll<DbContextOptions<SupportDbContext>>();
            services.RemoveAll<SupportDbContext>();
            services.RemoveAll<DbConnection>();

            // One connection held open for the fixture's lifetime: an in-memory
            // SQLite database exists only as long as a connection to it does.
            _connection = new SqliteConnection("DataSource=:memory:");
            _connection.Open();

            services.AddSingleton(_connection);
            services.AddDbContext<SqliteSupportDbContext>((sp, options) =>
                options.UseSqlite(sp.GetRequiredService<DbConnection>()));
            services.AddScoped<SupportDbContext>(sp => sp.GetRequiredService<SqliteSupportDbContext>());

            // Background sweeps are driven by hand in the tests that cover
            // them, so they are not left running underneath every other test.
            services.RemoveAll<IHostedService>();
        });
    }

    public SupportDbContext CreateDbContext()
    {
        IServiceScope scope = Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<SupportDbContext>();
    }

    /// <summary>Runs work inside a fresh scope, as a request would.</summary>
    public async Task<T> WithDbAsync<T>(Func<SupportDbContext, Task<T>> work)
    {
        using IServiceScope scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        return await work(db);
    }

    public Task WithDbAsync(Func<SupportDbContext, Task> work) =>
        WithDbAsync<object?>(async db =>
        {
            await work(db);
            return null;
        });

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
