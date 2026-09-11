using Mashura.CabinetSupport.Contracts.Enums;
using Mashura.CabinetSupport.Server.BackgroundServices;
using Mashura.CabinetSupport.Server.Configuration;
using Mashura.CabinetSupport.Server.Data;
using Mashura.CabinetSupport.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Mashura.CabinetSupport.Server.Tests;

/// <summary>
/// Retention keeps the telemetry tables bounded. It must never touch the
/// audit trail, at any age.
/// </summary>
public sealed class RetentionServiceTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public RetentionServiceTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Old_checkins_are_deleted_recent_ones_are_kept_and_audit_is_untouched()
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("retain"), Guid.NewGuid());

        DateTime nowUtc = DateTime.UtcNow;

        await _factory.WithDbAsync(async db =>
        {
            db.CheckIns.Add(NewCheckIn(cabinet.Id, nowUtc.AddDays(-60)));
            db.CheckIns.Add(NewCheckIn(cabinet.Id, nowUtc.AddDays(-45)));
            db.CheckIns.Add(NewCheckIn(cabinet.Id, nowUtc.AddDays(-2)));

            db.AuditEntries.Add(new Domain.AuditEntry
            {
                // Far older than any retention window, and still not the
                // retention service's business.
                TimestampUtc = nowUtc.AddYears(-5),
                ActorType = "System",
                Action = "test.ancient-audit",
                EventKind = AuditEventKind.Caused,
                Result = AuditResult.Success,
                CabinetId = cabinet.Id
            });

            await db.SaveChangesAsync();
        });

        await CreateService(new RetentionOptions
        {
            Enabled = true,
            CheckInRetentionDays = 30,
            SmartFullResolutionDays = 90,
            SmartAggregateRetentionDays = 730,
            BatchSize = 100
        }).SweepAsync(CancellationToken.None);

        List<CheckIn> remaining = await _factory.WithDbAsync(db => db.CheckIns
            .AsNoTracking().Where(c => c.CabinetId == cabinet.Id).ToListAsync());

        Assert.Single(remaining);
        Assert.True(remaining[0].ReceivedUtc > nowUtc.AddDays(-30));

        bool auditSurvived = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking().AnyAsync(a => a.Action == "test.ancient-audit"));

        Assert.True(auditSurvived, "Retention must never delete an audit record.");
    }

    [Fact]
    public async Task Aged_smart_readings_are_rolled_into_one_daily_row_per_drive()
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("smart"), Guid.NewGuid());

        DateTime day = DateTime.UtcNow.Date.AddDays(-200);

        await _factory.WithDbAsync(async db =>
        {
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-A", day.AddHours(2),
                reallocated: 5, spare: 90, health: DiskHealthStatus.Healthy));
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-A", day.AddHours(10),
                reallocated: 41, spare: 72, health: DiskHealthStatus.Warning));
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-A", day.AddHours(18),
                reallocated: 38, spare: 74, health: DiskHealthStatus.Healthy));

            await db.SaveChangesAsync();
        });

        await CreateService(new RetentionOptions
        {
            Enabled = true,
            CheckInRetentionDays = 30,
            SmartFullResolutionDays = 90,
            SmartAggregateRetentionDays = 730,
            BatchSize = 100
        }).SweepAsync(CancellationToken.None);

        List<SmartReading> rows = await _factory.WithDbAsync(db => db.SmartReadings
            .AsNoTracking()
            .Where(s => s.CabinetId == cabinet.Id && s.DriveSerial == "SERIAL-A")
            .ToListAsync());

        SmartReading aggregate = Assert.Single(rows);

        Assert.True(aggregate.IsAggregated);
        Assert.Equal(3, aggregate.SampleCount);
        Assert.Equal(day, aggregate.TimestampUtc);

        // The worst value of the day survives: an error count that spiked and
        // settled back is exactly what failure prediction needs to see, and an
        // average would erase it.
        Assert.Equal(41, aggregate.ReallocatedSectorCount);
        Assert.Equal(DiskHealthStatus.Warning, aggregate.PredictedHealth);

        // Spare capacity falls as a drive wears, so its worst case is the low.
        Assert.Equal(72, aggregate.AvailableSparePercent);
    }

    [Fact]
    public async Task Recent_smart_readings_are_left_at_full_resolution()
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("fresh"), Guid.NewGuid());

        DateTime today = DateTime.UtcNow.Date;

        await _factory.WithDbAsync(async db =>
        {
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-B", today.AddHours(1), 1, 99));
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-B", today.AddHours(9), 1, 99));
            await db.SaveChangesAsync();
        });

        await CreateService(new RetentionOptions { Enabled = true, SmartFullResolutionDays = 90 })
            .SweepAsync(CancellationToken.None);

        int rows = await _factory.WithDbAsync(db => db.SmartReadings
            .AsNoTracking()
            .CountAsync(s => s.CabinetId == cabinet.Id && s.DriveSerial == "SERIAL-B"));

        Assert.Equal(2, rows);
    }

    private RetentionService CreateService(RetentionOptions options) =>
        new(_factory.Services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(options),
            TimeProvider.System,
            NullLogger<RetentionService>.Instance);

    private static CheckIn NewCheckIn(Guid cabinetId, DateTime whenUtc) => new()
    {
        CabinetId = cabinetId,
        ReceivedUtc = whenUtc,
        CollectedAtUtc = whenUtc,
        PayloadJson = "{}",
        WorstDiskHealth = DiskHealthStatus.Healthy,
        MinFreeDiskPercent = 50
    };

    private static SmartReading NewReading(
        Guid cabinetId,
        string serial,
        DateTime whenUtc,
        long reallocated,
        int spare,
        DiskHealthStatus health = DiskHealthStatus.Healthy) => new()
    {
        CabinetId = cabinetId,
        DriveSerial = serial,
        TimestampUtc = whenUtc,
        ReallocatedSectorCount = reallocated,
        AvailableSparePercent = spare,
        PredictedHealth = health
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
