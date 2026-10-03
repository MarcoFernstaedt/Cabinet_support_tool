using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetReadGrantMigrationTests
{
    private const string Previous = "20261003153045_SuccessorReservation";
    private const string PreviousPostgres = "20261003153102_SuccessorReservation";

    [Fact]
    public async Task Sqlite_upgrade_enforces_exact_unique_pair_and_foreign_keys_and_downgrade_preserves_rows()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options;
        await using var db = new SqliteSupportDbContext(options);
        await db.GetService<IMigrator>().MigrateAsync(Previous);
        var user = new User { Username = "migration-reader", DisplayName = "Reader" };
        var cabinet = new Cabinet { MachineId = "migration-machine", Hostname = "host",
            Site = new Site { Name = "site", Client = new Client { Name = "client" } } };
        db.Users.Add(user);
        db.Cabinets.Add(cabinet);
        await db.SaveChangesAsync();
        await db.Database.MigrateAsync();
        db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        Assert.Equal(1, await db.CabinetReadGrants.CountAsync());
        await Assert.ThrowsAsync<DbUpdateException>(async () =>
        {
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id });
            await db.SaveChangesAsync();
        });
        db.ChangeTracker.Clear();
        await Assert.ThrowsAsync<DbUpdateException>(async () =>
        {
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = Guid.NewGuid(), CabinetId = cabinet.Id });
            await db.SaveChangesAsync();
        });
        db.ChangeTracker.Clear();
        await db.GetService<IMigrator>().MigrateAsync(Previous);
        Assert.Equal(user.Id, (await db.Users.AsNoTracking().SingleAsync(u => u.Username == user.Username)).Id);
        Assert.Equal(cabinet.Id, (await db.Cabinets.AsNoTracking().SingleAsync()).Id);
        await db.Database.MigrateAsync();
        Assert.Empty(await db.CabinetReadGrants.ToListAsync());
    }

    [Fact]
    public void Postgres_migration_generates_forward_and_rollback_sql_without_connecting()
    {
        var options = new DbContextOptionsBuilder<PostgresSupportDbContext>()
            .UseNpgsql("Host=localhost;Database=unused;Username=unused;Password=unused").Options;
        using var db = new PostgresSupportDbContext(options);
        var migrator = db.GetService<IMigrator>();
        string upgrade = migrator.GenerateScript(PreviousPostgres);
        Assert.Contains("CREATE TABLE \"CabinetReadGrants\"", upgrade);
        Assert.Contains("PRIMARY KEY (\"UserId\", \"CabinetId\")", upgrade);
        Assert.Contains("REFERENCES \"Users\"", upgrade);
        Assert.Contains("REFERENCES \"Cabinets\"", upgrade);
        string downgrade = migrator.GenerateScript("20261003171304_CabinetReadGrant", PreviousPostgres);
        Assert.Contains("DROP TABLE \"CabinetReadGrants\"", downgrade);
    }
}
