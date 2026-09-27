using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Tests;

public sealed class ConnectivityMigrationTests
{
    [Fact]
    public async Task Additive_sqlite_migrations_round_trip_without_dropping_existing_cabinets()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options;
        await using var db = new SqliteSupportDbContext(options);
        const string previous = "20260913201000_SessionContainment";
        // Seed with the current model, then downgrade before exercising the
        // historical upgrade. The current entity has additive columns absent
        // from the historical schema.
        await db.Database.MigrateAsync();
        var client = new Client { Name = "Migration fixture" };
        var site = new Site { Name = "Office", Client = client };
        var cabinet = new Cabinet { MachineId = "migration-connectivity-fixture", Hostname = "LAB", Site = site, IsActive = true };
        db.Cabinets.Add(cabinet);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        await db.GetService<IMigrator>().MigrateAsync(previous);
        await db.Database.MigrateAsync();
        db.ConnectivityConfigurations.Add(new ConnectivityConfiguration
        {
            SourceCabinetId = cabinet.Id, ConfigurationId = Guid.NewGuid(), SiteId = site.Id, UpdatedUtc = DateTimeOffset.UtcNow
        });
        db.ConnectivityEvidence.Add(new ConnectivityEvidence
        {
            Id = Guid.NewGuid(), SourceCabinetId = cabinet.Id, TargetCabinetId = Guid.NewGuid(),
            ConfigurationId = Guid.NewGuid(), FirstObservedUtc = DateTimeOffset.UtcNow.AddMinutes(-2),
            ObservedUtc = DateTimeOffset.UtcNow, ReceivedUtc = DateTimeOffset.UtcNow, SummaryJson = "{}"
        });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        await db.GetService<IMigrator>().MigrateAsync(previous);
        Assert.Equal(cabinet.Id, await db.Cabinets.Select(c => c.Id).SingleAsync());
        await db.Database.MigrateAsync();
        Assert.Empty(await db.ConnectivityConfigurations.ToArrayAsync());
        Assert.Empty(await db.ConnectivityEvidence.ToArrayAsync());
        Assert.Equal("LAB", (await db.Cabinets.SingleAsync()).Hostname);
    }
}
