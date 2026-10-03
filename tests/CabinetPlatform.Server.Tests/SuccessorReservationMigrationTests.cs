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
    public void Intent_target_models_retain_earlier_cabinet_read_grants()
    {
        using var sqlite = new SqliteSupportDbContext(
            new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite("Data Source=:memory:").Options);
        using var postgres = new PostgresSupportDbContext(
            new DbContextOptionsBuilder<PostgresSupportDbContext>().UseNpgsql("Host=localhost;Database=unused;Username=unused;Password=unused").Options);
        foreach (SupportDbContext db in new SupportDbContext[] { sqlite, postgres })
        {
            var assembly = db.GetService<IMigrationsAssembly>();
            var intent = assembly.Migrations.Single(m => m.Value.Name == "SuccessorIssuanceIntent");
            var migration = assembly.CreateMigration(intent.Value, db.Database.ProviderName!);
            Assert.NotNull(migration.TargetModel.FindEntityType(typeof(CabinetReadGrant)));
        }
    }

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

    [Fact]
    public async Task Intent_migration_round_trip_preserves_reservation_and_retired_predecessor()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options;
        await using var db = new SqliteSupportDbContext(options);
        const string previous = "20261003153045_SuccessorReservation";
        await db.GetService<IMigrator>().MigrateAsync(previous);
        var predecessor = new Cabinet { MachineId = "predecessor-intent-migration", Hostname = "old",
            IsActive = false, Site = new Site { Name = "site", Client = new Client { Name = "client" } } };
        var reservation = new SuccessorReservation { PredecessorCabinet = predecessor,
            SuccessorMachineId = "successor-intent-migration", ReservedUtc = DateTimeOffset.UtcNow };
        db.SuccessorReservations.Add(reservation);
        await db.SaveChangesAsync();
        await db.Database.MigrateAsync();
        db.SuccessorIssuanceIntents.Add(new SuccessorIssuanceIntent
        {
            PredecessorCabinetId = predecessor.Id, ReservationId = reservation.Id,
            RequestId = Guid.NewGuid(), ProposedKeyHash = new string('A', 64), RequestedUtc = DateTimeOffset.UtcNow
        });
        await db.SaveChangesAsync();
        Assert.Equal(1, await db.SuccessorIssuanceIntents.CountAsync());
        db.ChangeTracker.Clear();
        await db.GetService<IMigrator>().MigrateAsync(previous);
        Assert.Equal(1, await db.SuccessorReservations.CountAsync());
        Assert.False((await db.Cabinets.AsNoTracking().SingleAsync()).IsActive);
        await db.Database.MigrateAsync();
        Assert.Empty(await db.SuccessorIssuanceIntents.ToListAsync());
        Assert.Equal(1, await db.SuccessorReservations.CountAsync());
    }
}
