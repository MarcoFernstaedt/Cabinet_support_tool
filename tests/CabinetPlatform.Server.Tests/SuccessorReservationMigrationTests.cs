using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Tests;

public sealed class SuccessorReservationMigrationTests
{
    [Fact]
    public async Task Upgrade_and_downgrade_preserve_predecessor_history()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options;
        await using var db = new SqliteSupportDbContext(options);
        const string previous = "20261002010000_SmartReceiptProvenance";
        await db.GetService<IMigrator>().MigrateAsync(previous);
        var cabinet = new Cabinet { MachineId = "predecessor-migration", Hostname = "old",
            IsActive = false, Site = new Site { Name = "site", Client = new Client { Name = "client" } } };
        db.Cabinets.Add(cabinet);
        await db.SaveChangesAsync();
        await db.Database.MigrateAsync();
        db.SuccessorReservations.Add(new SuccessorReservation
        {
            PredecessorCabinetId = cabinet.Id, SuccessorMachineId = "successor-migration",
            ReservedUtc = DateTimeOffset.UtcNow
        });
        await db.SaveChangesAsync();
        Assert.Equal(1, await db.SuccessorReservations.CountAsync());
        db.ChangeTracker.Clear();
        await db.GetService<IMigrator>().MigrateAsync(previous);
        Assert.Equal(cabinet.MachineId, (await db.Cabinets.AsNoTracking().SingleAsync()).MachineId);
        Assert.False((await db.Cabinets.AsNoTracking().SingleAsync()).IsActive);
        await db.Database.MigrateAsync();
        Assert.Empty(await db.SuccessorReservations.ToListAsync());
        Assert.Equal(cabinet.MachineId, (await db.Cabinets.AsNoTracking().SingleAsync()).MachineId);
    }
}
