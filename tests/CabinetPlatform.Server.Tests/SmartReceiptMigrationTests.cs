using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Tests;

public sealed class SmartReceiptMigrationTests
{
    [Fact]
    public async Task Sqlite_upgrade_leaves_legacy_receipts_unknown_and_downgrade_preserves_readings()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options;
        await using var db = new SqliteSupportDbContext(options);
        const string previous = "20260927010000_CaseInsensitiveUsernames";
        await db.GetService<IMigrator>().MigrateAsync(previous);
        var client = new Client { Name = "Receipt migration fixture" };
        var site = new Site { Name = "Office", Client = client };
        var cabinet = new Cabinet { MachineId = "receipt-migration-fixture", Hostname = "LAB", Site = site, IsActive = true };
        db.Cabinets.Add(cabinet);
        await db.SaveChangesAsync();
        var oldId = Guid.NewGuid();
        var stamp = DateTimeOffset.UtcNow.AddDays(-2);
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO SmartReadings (Id, CabinetId, DriveSerial, TimestampUtc, Health, Source, IsAggregated, TemperatureCelsius) VALUES ({oldId}, {cabinet.Id}, {"private-drive"}, {stamp}, {0}, {0}, {false}, {31})");
        await db.Database.MigrateAsync();
        var legacy = await db.SmartReadings.AsNoTracking().SingleAsync(s => s.Id == oldId);
        Assert.Null(legacy.ReceivedUtc);
        Assert.Equal(31, legacy.TemperatureCelsius);
        var newId = Guid.NewGuid();
        var receipt = DateTimeOffset.UtcNow;
        db.SmartReadings.Add(new SmartReading { Id = newId, CabinetId = cabinet.Id, DriveSerial = "private-drive",
            TimestampUtc = stamp.AddHours(1), ReceivedUtc = receipt, TemperatureCelsius = 42 });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        await db.GetService<IMigrator>().MigrateAsync(previous);
        await db.Database.MigrateAsync();
        var rows = await db.SmartReadings.AsNoTracking().Where(s => s.CabinetId == cabinet.Id).ToArrayAsync();
        Assert.Equal(2, rows.Length);
        Assert.All(rows, s => Assert.Null(s.ReceivedUtc));
        Assert.Equal(31, rows.Single(s => s.Id == oldId).TemperatureCelsius);
        Assert.Equal(42, rows.Single(s => s.Id == newId).TemperatureCelsius);
    }
}
