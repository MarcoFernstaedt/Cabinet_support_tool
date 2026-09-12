using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.BackgroundServices;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// Retention keeps the telemetry tables bounded. It must never touch the
/// audit trail, at any age.
/// </summary>
public sealed class RetentionServiceTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public RetentionServiceTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Aged_heartbeats_are_folded_hourly_then_deleted_and_audit_is_untouched()
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("retain"), Guid.NewGuid());

        DateTimeOffset nowUtc = DateTimeOffset.UtcNow;
        string correlationId = Unique("ancient-audit");

        // Two samples inside one hour 45 days ago — old enough to fold, young
        // enough to keep — one sample 200 days ago, past even the aggregate
        // window, and one from two hours ago that must not be touched at all.
        //
        // Pinned to the start of the hour rather than offset from now: two
        // samples five minutes apart straddle an hour boundary whenever the
        // suite happens to run near one, and would then fold into two rows.
        DateTimeOffset foldable = TruncateToHour(nowUtc.AddDays(-45));

        await _factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(NewHeartbeat(cabinet.Id, foldable, cpu: 12, ramUsed: 30));
            db.Heartbeats.Add(NewHeartbeat(cabinet.Id, foldable.AddMinutes(5), cpu: 98, ramUsed: 41));
            db.Heartbeats.Add(NewHeartbeat(cabinet.Id, nowUtc.AddDays(-200), cpu: 5, ramUsed: 10));
            db.Heartbeats.Add(NewHeartbeat(cabinet.Id, nowUtc.AddHours(-2), cpu: 7, ramUsed: 22));

            db.AuditEntries.Add(new Domain.AuditEntry
            {
                // Far older than any retention window, and still not the
                // retention service's business.
                TimestampUtc = nowUtc.AddYears(-5),
                ActorType = ActorType.System,
                Event = AuditEvent.RetentionSweep,
                EventKind = AuditEventKind.Caused,
                Result = AuditResult.Success,
                CabinetId = cabinet.Id,
                CorrelationId = correlationId
            });

            await db.SaveChangesAsync();
        });

        await CreateService(new RetentionOptions
        {
            Enabled = true,
            HeartbeatFullResolutionDays = 7,
            HeartbeatAggregateRetentionDays = 90,
            SmartFullResolutionDays = 90,
            SmartAggregateRetentionDays = 730,
            BatchSize = 100
        }).SweepAsync(CancellationToken.None);

        List<Heartbeat> remaining = await _factory.WithDbAsync(db => db.Heartbeats
            .AsNoTracking()
            .Where(h => h.CabinetId == cabinet.Id)
            .OrderBy(h => h.ReceivedUtc)
            .ToListAsync());

        // The 200-day row is gone; the two 45-day samples became one hourly
        // row; this morning's sample is untouched.
        Assert.Equal(2, remaining.Count);

        Heartbeat aggregate = Assert.Single(remaining, h => h.IsAggregated);
        Assert.Equal(2, aggregate.SampleCount);

        // The worst value of the hour survives, not the mean. A cabinet that
        // spent five minutes pinned at 98% CPU had a problem; averaging it with
        // a quiet hour erases exactly the evidence somebody would go looking
        // for.
        Assert.Equal(98, aggregate.CpuPercent);
        Assert.Equal(41, aggregate.RamUsedPercent);

        Heartbeat live = Assert.Single(remaining, h => !h.IsAggregated);
        Assert.Equal(7, live.CpuPercent);

        bool auditSurvived = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking().AnyAsync(a => a.CorrelationId == correlationId));

        Assert.True(auditSurvived, "Retention must never delete an audit record.");
    }

    [Fact]
    public async Task An_unreadable_logged_on_flag_survives_aggregation_as_unknown()
    {
        // The one counter where folding to a default is dangerous rather than
        // merely lossy. An hour holding one sample the collector could not read
        // aggregates to unknown, never to "nobody was logged on" — the server
        // gates reboots on this value.
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("loggedon"), Guid.NewGuid());

        DateTimeOffset hour = TruncateToHour(DateTimeOffset.UtcNow.AddDays(-45));

        await _factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(NewHeartbeat(cabinet.Id, hour, loggedOn: false));
            db.Heartbeats.Add(NewHeartbeat(cabinet.Id, hour.AddMinutes(5), loggedOn: null));

            // Both inside one hour, so they fold into one row. See the pinning
            // note above for why the hour is truncated rather than offset.

            await db.SaveChangesAsync();
        });

        await CreateService(new RetentionOptions { Enabled = true, BatchSize = 100 })
            .SweepAsync(CancellationToken.None);

        Heartbeat aggregate = await _factory.WithDbAsync(db => db.Heartbeats
            .AsNoTracking().FirstAsync(h => h.CabinetId == cabinet.Id && h.IsAggregated));

        Assert.Null(aggregate.AnyUserLoggedOn);
    }

    [Fact]
    public async Task Aged_smart_readings_are_rolled_into_one_daily_row_per_drive()
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("smart"), Guid.NewGuid());

        DateTimeOffset day = TruncateToDay(DateTimeOffset.UtcNow.AddDays(-200));

        await _factory.WithDbAsync(async db =>
        {
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-A", day.AddHours(2),
                reallocated: 5, wear: 70, health: DiskHealthStatus.Healthy));
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-A", day.AddHours(10),
                reallocated: 41, wear: 90, health: DiskHealthStatus.Watch));
            db.SmartReadings.Add(NewReading(cabinet.Id, "SERIAL-A", day.AddHours(18),
                reallocated: 38, wear: 72, health: DiskHealthStatus.Healthy));

            await db.SaveChangesAsync();
        });

        await CreateService(new RetentionOptions
        {
            Enabled = true,
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
        Assert.Equal(day, aggregate.TimestampUtc);

        // The worst value of the day survives: an error count that spiked and
        // settled back is exactly what failure prediction needs to see, and an
        // average would erase it.
        Assert.Equal(41, aggregate.ReallocatedSectorCount);
        Assert.Equal(DiskHealthStatus.Watch, aggregate.Health);

        // Wear is endurance consumed, so its worst case is the high.
        Assert.Equal(90, aggregate.Wear);

        // A counter no reading carried stays absent rather than becoming zero.
        Assert.Null(aggregate.PendingSectorCount);
        Assert.Null(aggregate.PowerOnHours);

        // And the aggregate says where its numbers came from.
        Assert.Equal(SmartSource.StorageReliabilityCounter, aggregate.Source);
    }

    [Fact]
    public async Task Recent_smart_readings_are_left_at_full_resolution()
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("fresh"), Guid.NewGuid());

        DateTimeOffset today = TruncateToDay(DateTimeOffset.UtcNow);

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

    private static DateTimeOffset TruncateToDay(DateTimeOffset value) =>
        new(value.Year, value.Month, value.Day, 0, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset TruncateToHour(DateTimeOffset value) =>
        new(value.Year, value.Month, value.Day, value.Hour, 0, 0, TimeSpan.Zero);

    private static Heartbeat NewHeartbeat(
        Guid cabinetId,
        DateTimeOffset whenUtc,
        double? cpu = null,
        double? ramUsed = null,
        bool? loggedOn = false) => new()
    {
        CabinetId = cabinetId,
        ReceivedUtc = whenUtc,
        CollectedAtUtc = whenUtc,
        SectionErrorsJson = "{}",
        WorstDiskHealth = DiskHealthStatus.Healthy,
        CpuPercent = cpu,
        RamUsedPercent = ramUsed,
        AnyUserLoggedOn = loggedOn,
        MinFreeDiskPercent = 50,
    };

    private static SmartReading NewReading(
        Guid cabinetId,
        string serial,
        DateTimeOffset whenUtc,
        int reallocated,
        int wear,
        DiskHealthStatus health = DiskHealthStatus.Healthy) => new()
    {
        CabinetId = cabinetId,
        DriveSerial = serial,
        TimestampUtc = whenUtc,
        Source = SmartSource.StorageReliabilityCounter,
        ReallocatedSectorCount = reallocated,
        Wear = wear,
        Health = health,
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
