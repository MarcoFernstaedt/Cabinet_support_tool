using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetNameMigrationTests
{
    [Fact]
    public async Task Sqlite_name_survives_reopen_and_downgrade_preserves_device_identity()
    {
        string path = Path.Combine(Path.GetTempPath(), $"cabinet-name-{Guid.NewGuid():N}.db");
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite($"Data Source={path};Pooling=False").Options;
        Guid id;
        Guid siteId;
        try
        {
            await using (var db = new SqliteSupportDbContext(options))
            {
                await db.Database.MigrateAsync();
                var site = new Site { Name = "Site", Client = new Client { Name = "Client" } };
                var cabinet = new Cabinet { MachineId = "immutable-device", Hostname = "HOST", FriendlyName = "Pharmacy", Site = site };
                db.Cabinets.Add(cabinet);
                await db.SaveChangesAsync();
                id = cabinet.Id; siteId = site.Id;
            }
            await using (var reopened = new SqliteSupportDbContext(options))
            {
                var cabinet = await reopened.Cabinets.AsNoTracking().SingleAsync();
                Assert.Equal("Pharmacy", cabinet.FriendlyName);
                Assert.Equal(id, cabinet.Id);
                await reopened.GetService<IMigrator>().MigrateAsync("20260919195255_ConnectivityEvidence");
                var identities = await reopened.Cabinets.Select(c => new { c.Id, c.MachineId, c.Hostname, c.SiteId }).SingleAsync();
                Assert.Equal(id, identities.Id); Assert.Equal(siteId, identities.SiteId);
                Assert.Equal("immutable-device", identities.MachineId); Assert.Equal("HOST", identities.Hostname);
                await reopened.Database.MigrateAsync();
                Assert.Null((await reopened.Cabinets.AsNoTracking().SingleAsync()).FriendlyName);
            }
        }
        finally { File.Delete(path); }
    }
}
