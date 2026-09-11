using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.BackgroundServices;

/// <summary>
/// Keeps the telemetry tables from growing without bound.
///
/// Three rules, and one deliberate omission:
///   * Check-in rows older than the configured window are deleted outright.
///   * SMART readings older than the full-resolution window are rolled into
///     one row per drive per day rather than deleted, because predicting a
///     drive failure means comparing a drive against its own history.
///   * Those daily aggregates are kept far longer, then finally deleted.
///
/// AuditEntry appears nowhere in this file. Audit records are never deleted
/// and never aggregated by this service, at any age.
/// </summary>
public sealed class RetentionService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly RetentionOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<RetentionService> _logger;

    public RetentionService(
        IServiceScopeFactory scopeFactory,
        IOptions<RetentionOptions> options,
        TimeProvider timeProvider,
        ILogger<RetentionService> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            _logger.LogInformation("Retention sweeps are disabled by configuration.");
            return;
        }

        var interval = TimeSpan.FromHours(Math.Max(1, _options.SweepIntervalHours));

        // A short initial delay keeps a heavy sweep off the cold-start path,
        // which matters when several instances restart together behind a
        // load balancer.
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), _timeProvider, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A failed sweep must never take the host down: the data it
                // would have tidied is still perfectly usable.
                _logger.LogError(ex, "Retention sweep failed; will retry at the next interval.");
            }

            try
            {
                await Task.Delay(interval, _timeProvider, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    internal async Task SweepAsync(CancellationToken ct)
    {
        using IServiceScope scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var audit = scope.ServiceProvider.GetRequiredService<IAuditService>();

        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        int checkInsDeleted = await DeleteCheckInsAsync(db, nowUtc, ct);
        (int aggregatesWritten, int readingsFolded) = await AggregateSmartAsync(db, nowUtc, ct);
        int aggregatesDeleted = await DeleteAgedAggregatesAsync(db, nowUtc, ct);

        if (checkInsDeleted == 0 && aggregatesWritten == 0 && aggregatesDeleted == 0)
        {
            return;
        }

        _logger.LogInformation(
            "Retention sweep removed {CheckIns} check-ins, folded {Folded} SMART readings into " +
            "{Aggregates} daily aggregates and removed {Expired} aged aggregates.",
            checkInsDeleted, readingsFolded, aggregatesWritten, aggregatesDeleted);

        await audit.WriteAsync(new AuditRecord
        {
            Action = AuditActions.RetentionSweep,
            // The server tidied its own store. Nothing on a cabinet changed.
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.System,
            ActorDisplayName = nameof(RetentionService),
            Details = new
            {
                CheckInsDeleted = checkInsDeleted,
                SmartReadingsFolded = readingsFolded,
                SmartAggregatesWritten = aggregatesWritten,
                SmartAggregatesDeleted = aggregatesDeleted,
                _options.CheckInRetentionDays,
                _options.SmartFullResolutionDays,
                _options.SmartAggregateRetentionDays
            }
        }, ct);
    }

    private async Task<int> DeleteCheckInsAsync(SupportDbContext db, DateTime nowUtc, CancellationToken ct)
    {
        DateTime cutoff = nowUtc.AddDays(-_options.CheckInRetentionDays);
        int deleted = 0;

        while (!ct.IsCancellationRequested)
        {
            // Batched so a long-overdue first sweep does not hold one enormous
            // transaction open across the request path.
            List<CheckIn> batch = await db.CheckIns
                .Where(c => c.ReceivedUtc < cutoff)
                .OrderBy(c => c.ReceivedUtc)
                .Take(_options.BatchSize)
                .ToListAsync(ct);

            if (batch.Count == 0)
            {
                break;
            }

            db.CheckIns.RemoveRange(batch);
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();

            deleted += batch.Count;

            if (batch.Count < _options.BatchSize)
            {
                break;
            }
        }

        return deleted;
    }

    /// <summary>
    /// Folds aged full-resolution readings into one row per drive per day.
    ///
    /// The aggregate keeps the worst value seen that day for every counter,
    /// which is the shape failure prediction needs: a reallocated-sector count
    /// that touched 40 and settled back matters, and an average would hide it.
    /// </summary>
    private async Task<(int Aggregates, int Folded)> AggregateSmartAsync(
        SupportDbContext db, DateTime nowUtc, CancellationToken ct)
    {
        DateTime cutoff = nowUtc.Date.AddDays(-_options.SmartFullResolutionDays);

        int aggregates = 0;
        int folded = 0;

        while (!ct.IsCancellationRequested)
        {
            List<SmartReading> batch = await db.SmartReadings
                .Where(s => !s.IsAggregated && s.TimestampUtc < cutoff)
                .OrderBy(s => s.TimestampUtc)
                .Take(_options.BatchSize)
                .ToListAsync(ct);

            if (batch.Count == 0)
            {
                break;
            }

            // Group in memory: the batch is already bounded, and the
            // worst-of-day fold is not something to push into SQL that has to
            // stay provider-neutral.
            var groups = batch
                .GroupBy(s => new { s.CabinetId, s.DriveSerial, Day = s.TimestampUtc.Date })
                .ToList();

            foreach (var group in groups)
            {
                SmartReading? existing = await db.SmartReadings
                    .FirstOrDefaultAsync(s =>
                        s.IsAggregated &&
                        s.CabinetId == group.Key.CabinetId &&
                        s.DriveSerial == group.Key.DriveSerial &&
                        s.TimestampUtc == group.Key.Day, ct);

                if (existing is null)
                {
                    existing = new SmartReading
                    {
                        CabinetId = group.Key.CabinetId,
                        DriveSerial = group.Key.DriveSerial,
                        TimestampUtc = group.Key.Day,
                        IsAggregated = true,
                        SampleCount = 0,
                        PredictedHealth = DiskHealthStatus.Unknown
                    };

                    db.SmartReadings.Add(existing);
                    aggregates++;
                }

                Fold(existing, group);
                folded += group.Count();
            }

            db.SmartReadings.RemoveRange(batch);
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();

            if (batch.Count < _options.BatchSize)
            {
                break;
            }
        }

        return (aggregates, folded);
    }

    private static void Fold(SmartReading target, IEnumerable<SmartReading> source)
    {
        foreach (SmartReading s in source)
        {
            target.DriveModel ??= s.DriveModel;
            target.FirmwareVersion ??= s.FirmwareVersion;
            target.DeviceId ??= s.DeviceId;
            target.SampleCount++;

            if (s.PredictedHealth > target.PredictedHealth)
            {
                target.PredictedHealth = s.PredictedHealth;
            }

            // Error counters are monotonic on real hardware, so the maximum is
            // the day's true reading; a null stays null rather than becoming a
            // zero that would read as good news.
            target.ReallocatedSectorCount = Max(target.ReallocatedSectorCount, s.ReallocatedSectorCount);
            target.ReportedUncorrectableErrors =
                Max(target.ReportedUncorrectableErrors, s.ReportedUncorrectableErrors);
            target.CommandTimeoutCount = Max(target.CommandTimeoutCount, s.CommandTimeoutCount);
            target.CurrentPendingSectorCount =
                Max(target.CurrentPendingSectorCount, s.CurrentPendingSectorCount);
            target.OfflineUncorrectableCount =
                Max(target.OfflineUncorrectableCount, s.OfflineUncorrectableCount);
            target.UdmaCrcErrorCount = Max(target.UdmaCrcErrorCount, s.UdmaCrcErrorCount);
            target.SpinRetryCount = Max(target.SpinRetryCount, s.SpinRetryCount);
            target.SeekErrorRate = Max(target.SeekErrorRate, s.SeekErrorRate);
            target.ReadErrorRate = Max(target.ReadErrorRate, s.ReadErrorRate);
            target.WearLevelingCount = Max(target.WearLevelingCount, s.WearLevelingCount);
            target.MediaAndDataIntegrityErrors =
                Max(target.MediaAndDataIntegrityErrors, s.MediaAndDataIntegrityErrors);
            target.UnsafeShutdownCount = Max(target.UnsafeShutdownCount, s.UnsafeShutdownCount);
            target.PowerOnHours = Max(target.PowerOnHours, s.PowerOnHours);
            target.PowerCycleCount = Max(target.PowerCycleCount, s.PowerCycleCount);
            target.TotalHostReadsGb = Max(target.TotalHostReadsGb, s.TotalHostReadsGb);
            target.TotalHostWritesGb = Max(target.TotalHostWritesGb, s.TotalHostWritesGb);

            target.PercentageUsed = Max(target.PercentageUsed, s.PercentageUsed);
            target.TemperatureCelsius = Max(target.TemperatureCelsius, s.TemperatureCelsius);

            // Spare capacity falls as a drive wears, so the worst case is the
            // minimum rather than the maximum.
            target.AvailableSparePercent = Min(target.AvailableSparePercent, s.AvailableSparePercent);
            target.AvailableSpareThresholdPercent =
                Min(target.AvailableSpareThresholdPercent, s.AvailableSpareThresholdPercent);
        }
    }

    private async Task<int> DeleteAgedAggregatesAsync(
        SupportDbContext db, DateTime nowUtc, CancellationToken ct)
    {
        DateTime cutoff = nowUtc.AddDays(-_options.SmartAggregateRetentionDays);
        int deleted = 0;

        while (!ct.IsCancellationRequested)
        {
            List<SmartReading> batch = await db.SmartReadings
                .Where(s => s.TimestampUtc < cutoff)
                .OrderBy(s => s.TimestampUtc)
                .Take(_options.BatchSize)
                .ToListAsync(ct);

            if (batch.Count == 0)
            {
                break;
            }

            db.SmartReadings.RemoveRange(batch);
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();

            deleted += batch.Count;

            if (batch.Count < _options.BatchSize)
            {
                break;
            }
        }

        return deleted;
    }

    private static long? Max(long? a, long? b) =>
        a is null ? b : b is null ? a : Math.Max(a.Value, b.Value);

    private static int? Max(int? a, int? b) =>
        a is null ? b : b is null ? a : Math.Max(a.Value, b.Value);

    private static int? Min(int? a, int? b) =>
        a is null ? b : b is null ? a : Math.Min(a.Value, b.Value);
}
