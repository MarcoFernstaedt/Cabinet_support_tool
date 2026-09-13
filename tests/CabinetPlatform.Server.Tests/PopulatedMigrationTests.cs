using CabinetPlatform.Server.Data;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Tests;

public sealed class PopulatedMigrationTests
{
    [Fact]
    public async Task Legacy_cabinets_sharing_clients_and_sites_upgrade_without_duplicate_topology()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options;
        await using var db = new SqliteSupportDbContext(options);
        await db.GetService<IMigrator>().MigrateAsync("20260911012609_InitialSchema");
        for (int i = 0; i < 4; i++)
        {
            string client = i == 3 ? "Other client" : "Shared client";
            string site = i == 2 ? "Other site" : "Shared site";
            await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO Cabinets (Id, MachineId, Hostname, ClientName, SiteName, ApprovedUtc, ApprovedByUserId, IsActive) VALUES ({Guid.NewGuid()}, {$"machine-{i}"}, {$"host-{i}"}, {client}, {site}, {DateTime.UtcNow}, {Guid.NewGuid()}, {true})");
        }
        await db.Database.MigrateAsync();
        Assert.Equal(4, await db.Cabinets.CountAsync());
        Assert.Equal(2, await db.Clients.CountAsync());
        Assert.Equal(3, await db.Sites.CountAsync());
        var cabinets = await db.Cabinets.Include(c => c.Site).ThenInclude(s => s!.Client).OrderBy(c => c.MachineId).ToListAsync();
        Assert.Equal(cabinets[0].SiteId, cabinets[1].SiteId);
        Assert.NotEqual(cabinets[0].SiteId, cabinets[2].SiteId);
        Assert.Equal("Other client", cabinets[3].Site!.Client!.Name);
        Assert.All(cabinets, c => Assert.NotNull(c.Site));
    }
}
