using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Tests;
public sealed class ConnectivityAlertMigrationTests
{
    [Fact]
    public async Task File_database_reopens_and_alert_only_downgrade_preserves_source_and_evidence()
    {
        string path = Path.Combine(Path.GetTempPath(), "alert-migration-" + Guid.NewGuid() + ".db");
        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite($"Data Source={path};Pooling=False").Options;
        Guid sourceId, evidenceId;
        try
        {
            await using (var db = new SqliteSupportDbContext(options))
            {
                await db.Database.MigrateAsync();
                var site = new Site { Name = "Lab", Client = new Client { Name = "Migration lab" } };
                var cabinet = new Cabinet { MachineId = Guid.NewGuid().ToString(), Hostname = "Lab", Site = site, IsActive = true };
                db.Cabinets.Add(cabinet); await db.SaveChangesAsync(); sourceId = cabinet.Id;
                var evidence = new ConnectivityEvidence { Id = Guid.NewGuid(), SourceCabinetId = sourceId, TargetCabinetId = Guid.NewGuid(),
                    ConfigurationId = Guid.NewGuid(), FirstObservedUtc = DateTimeOffset.UtcNow.AddMinutes(-3), ObservedUtc = DateTimeOffset.UtcNow,
                    ReceivedUtc = DateTimeOffset.UtcNow, SummaryJson = "{}" };
                evidenceId = evidence.Id; db.ConnectivityEvidence.Add(evidence);
                db.ConnectivityAlerts.Add(new ConnectivityAlert { SourceCabinetId = sourceId, TargetCabinetId = evidence.TargetCabinetId,
                    EvidenceId = evidenceId, ReceivedUtc = DateTimeOffset.UtcNow, ObservedUtc = null });
                await db.SaveChangesAsync();
            }
            await using (var db = new SqliteSupportDbContext(options))
            {
                Assert.Null((await db.ConnectivityAlerts.SingleAsync()).ObservedUtc);
                var migrations = (await db.Database.GetAppliedMigrationsAsync()).ToArray();
                int alertIndex = Array.FindIndex(migrations, m => m.EndsWith("_ConnectivityAlerts", StringComparison.Ordinal));
                int priorIndex = Array.FindIndex(migrations, m => m == "20260920011114_CabinetFriendlyName");
                Assert.True(alertIndex > priorIndex && priorIndex >= 0);
                await db.GetService<IMigrator>().MigrateAsync(migrations[priorIndex]);
                Assert.Equal(sourceId, await db.Cabinets.Select(c => c.Id).SingleAsync());
                Assert.Equal(evidenceId, await db.ConnectivityEvidence.Select(e => e.Id).SingleAsync());
                Assert.Equal(migrations[..(priorIndex + 1)], (await db.Database.GetAppliedMigrationsAsync()).ToArray());
                await db.Database.MigrateAsync();
                Assert.Empty(await db.ConnectivityAlerts.ToArrayAsync());
                Assert.Equal(migrations, (await db.Database.GetAppliedMigrationsAsync()).ToArray());
            }
        }
        finally { File.Delete(path); }
    }
}
