using CabinetPlatform.Contracts.Audit;
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
/// </summary>
/// <remarks>
/// <para>
/// Four rules, and one deliberate omission:
/// </para>
/// <list type="bullet">
/// <item>Heartbeats are kept at full resolution for a week, then folded into
/// one row per cabinet per hour and kept for a quarter. Two million samples a
/// day is not a volume to keep at five-minute resolution for its own sake.</item>
/// <item>SMART readings older than the full-resolution window are rolled into
/// one row per drive per day rather than deleted, because predicting a drive
/// failure means comparing a drive against its own history.</item>
/// <item>Those daily aggregates are kept for two years, then deleted.</item>
/// <item>Inventory versions are a change history and are not aged out by time
/// at all. Only a per-cabinet cap applies, so a cabinet flapping between two
/// configurations cannot grow without bound.</item>
/// </list>
/// <para>
/// <see cref="AuditEntry"/> appears nowhere in this file. Audit records are
/// never deleted and never aggregated by this service, at any age.
/// </para>
/// </remarks>
public sealed class RetentionService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly RetentionOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<RetentionService> _logger;

    /// <summary>Creates the service.</summary>
    /// <param name="scopeFactory">Creates a scope per sweep.</param>
    /// <param name="options">Retention configuration.</param>
    /// <param name="timeProvider">Clock.</param>
    /// <param name="logger">Diagnostic log.</param>
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

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            _logger.LogInformation("Retention sweeps are disabled by configuration.");
            return;
        }

        var interval = TimeSpan.FromHours(Math.Max(1, _options.SweepIntervalHours));

        // A short initial delay keeps a heavy sweep off the cold-start path,
        // which matters when several instances restart together.
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

    /// <summary>Runs one sweep. Internal so tests can drive it without a timer.</summary>
    /// <param name="ct">Cancels the sweep.</param>
    internal async Task SweepAsync(CancellationToken ct)
    {
        using IServiceScope scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var audit = scope.ServiceProvider.GetRequiredService<IAuditService>();

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        int hourlyWritten = 0, heartbeatsFolded = 0, heartbeatsDeleted = 0;
        int dailyWritten = 0, readingsFolded = 0, smartDeleted = 0, inventoriesTrimmed = 0;
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        // Round-robin categories so a heartbeat backlog cannot starve SMART or
        // inventory. Transactions and tracked rows remain bounded per batch.
        // The time budget is checked between rounds, not inside a transaction.
        do
        {
            ct.ThrowIfCancellationRequested();
            var hourly = await AggregateHeartbeatsAsync(db, nowUtc, ct);
            int deletedHeartbeats = await DeleteAgedHeartbeatsAsync(db, nowUtc, ct);
            var daily = await AggregateSmartAsync(db, nowUtc, ct);
            int deletedSmart = await DeleteAgedSmartAggregatesAsync(db, nowUtc, ct);
            int trimmed = await TrimInventoryVersionsAsync(db, ct);
            hourlyWritten += hourly.Written;
            heartbeatsFolded += hourly.Folded;
            heartbeatsDeleted += deletedHeartbeats;
            dailyWritten += daily.Written;
            readingsFolded += daily.Folded;
            smartDeleted += deletedSmart;
            inventoriesTrimmed += trimmed;
            db.ChangeTracker.Clear();
            if (hourly.Folded + deletedHeartbeats + daily.Folded + deletedSmart + trimmed == 0)
                break;
        } while (elapsed.Elapsed < TimeSpan.FromMinutes(5));

        int touched = heartbeatsFolded + heartbeatsDeleted + readingsFolded + smartDeleted + inventoriesTrimmed;

        if (touched == 0)
        {
            return;
        }

        _logger.LogInformation(
            "Retention sweep folded {Heartbeats} heartbeats into {Hourly} hourly rows, removed " +
            "{ExpiredHeartbeats} aged heartbeat rows, folded {Readings} SMART readings into {Daily} " +
            "daily rows, removed {ExpiredSmart} aged SMART rows and trimmed {Inventories} inventory " +
            "versions.",
            heartbeatsFolded, hourlyWritten, heartbeatsDeleted,
            readingsFolded, dailyWritten, smartDeleted, inventoriesTrimmed);

        await audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.RetentionSweep,
            // The server tidied its own store. Nothing on a cabinet changed.
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.System,
            ActorId = nameof(RetentionService),
            ActorDisplayName = nameof(RetentionService),
            Details = new
            {
                HeartbeatsFolded = heartbeatsFolded,
                HourlyAggregatesWritten = hourlyWritten,
                AgedHeartbeatsDeleted = heartbeatsDeleted,
                SmartReadingsFolded = readingsFolded,
                DailyAggregatesWritten = dailyWritten,
                AgedSmartAggregatesDeleted = smartDeleted,
                InventoryVersionsTrimmed = inventoriesTrimmed,
            },
        }, ct);
    }

    /// <summary>
    /// Folds full-resolution heartbeats older than the window into one row per
    /// cabinet per hour.
    /// </summary>
    /// <remarks>
    /// The aggregate keeps the <em>worst</em> value of each counter over the
    /// hour, not the mean. A cabinet that spent five minutes at ninety-eight
    /// percent memory and fifty-five minutes idle had a problem, and an average
    /// would erase it. Counters that were null throughout stay null: an hour
    /// with no reading aggregates to no reading, never to zero.
    /// </remarks>
    private async Task<(int Written, int Folded)> AggregateHeartbeatsAsync(
        SupportDbContext db, DateTimeOffset nowUtc, CancellationToken ct)
    {
        DateTimeOffset cutoff = nowUtc.AddDays(-_options.HeartbeatFullResolutionDays);

        List<Heartbeat> due = await db.Heartbeats
            .Where(h => !h.IsAggregated && h.ReceivedUtc < cutoff)
            .OrderBy(h => h.ReceivedUtc)
            .Take(_options.BatchSize)
            .ToListAsync(ct);

        if (due.Count == 0)
        {
            return (0, 0);
        }

        var written = 0;

        foreach (IGrouping<(Guid CabinetId, DateTimeOffset Hour), Heartbeat> group in
                 due.GroupBy(h => (h.CabinetId, Hour: TruncateToHour(h.ReceivedUtc))))
        {
            List<Heartbeat> rows = group.ToList();

            Heartbeat? existing = await db.Heartbeats.FirstOrDefaultAsync(
                h => h.CabinetId == group.Key.CabinetId &&
                     h.IsAggregated &&
                     h.CollectedAtUtc == group.Key.Hour, ct);

            if (existing is null)
            {
                existing = new Heartbeat
                {
                    CabinetId = group.Key.CabinetId,
                    ReceivedUtc = group.Key.Hour,
                    CollectedAtUtc = group.Key.Hour,
                    IsAggregated = true,
                    SampleCount = 0,
                    SectionErrorsJson = "{}",
                    WorstDiskHealth = rows[0].WorstDiskHealth,
                };

                db.Heartbeats.Add(existing);
                written++;
            }

            existing.AgentVersion ??= rows.Select(r => r.AgentVersion).LastOrDefault(v => v is not null);
            existing.SampleCount += rows.Sum(r => r.SampleCount);
            existing.UptimeSeconds = Max(existing.UptimeSeconds, rows.Max(r => r.UptimeSeconds));
            existing.CpuPercent = Max(existing.CpuPercent, rows.Max(r => r.CpuPercent));
            existing.RamUsedPercent = Max(existing.RamUsedPercent, rows.Max(r => r.RamUsedPercent));
            existing.MinFreeDiskPercent = Min(existing.MinFreeDiskPercent, rows.Min(r => r.MinFreeDiskPercent));
            existing.PendingUpdateCount = Max(existing.PendingUpdateCount, rows.Max(r => r.PendingUpdateCount));
            existing.RebootPending = Or(existing.RebootPending, rows);
            existing.AnyUserLoggedOn = OrLoggedOn(existing.AnyUserLoggedOn, rows);
            existing.ClockDriftSeconds = MaxMagnitude(
                existing.ClockDriftSeconds, rows.Select(r => r.ClockDriftSeconds));
            existing.WorstDiskHealth = rows
                .Select(r => r.WorstDiskHealth)
                .Aggregate(existing.WorstDiskHealth, WorseDisk);

            db.Heartbeats.RemoveRange(rows);
        }

        await db.SaveChangesAsync(ct);
        return (written, due.Count);
    }

    private async Task<int> DeleteAgedHeartbeatsAsync(
        SupportDbContext db, DateTimeOffset nowUtc, CancellationToken ct)
    {
        DateTimeOffset cutoff = nowUtc.AddDays(-_options.HeartbeatAggregateRetentionDays);

        List<Heartbeat> aged = await db.Heartbeats
            .Where(h => h.ReceivedUtc < cutoff)
            .Take(_options.BatchSize)
            .ToListAsync(ct);

        if (aged.Count == 0)
        {
            return 0;
        }

        db.Heartbeats.RemoveRange(aged);
        await db.SaveChangesAsync(ct);
        return aged.Count;
    }

    /// <summary>
    /// Folds full-resolution SMART readings older than the window into one row
    /// per drive per day, holding that day's worst observed value for each
    /// counter.
    /// </summary>
    private async Task<(int Written, int Folded)> AggregateSmartAsync(
        SupportDbContext db, DateTimeOffset nowUtc, CancellationToken ct)
    {
        DateTimeOffset cutoff = nowUtc.AddDays(-_options.SmartFullResolutionDays);

        List<SmartReading> due = await db.SmartReadings
            .Where(s => !s.IsAggregated && s.TimestampUtc < cutoff)
            .OrderBy(s => s.TimestampUtc)
            .Take(_options.BatchSize)
            .ToListAsync(ct);

        if (due.Count == 0)
        {
            return (0, 0);
        }

        var written = 0;

        foreach (IGrouping<(Guid CabinetId, string Serial, DateTimeOffset Day), SmartReading> group in
                 due.GroupBy(s => (s.CabinetId, Serial: s.DriveSerial, Day: TruncateToDay(s.TimestampUtc))))
        {
            List<SmartReading> rows = group.ToList();

            SmartReading? existing = await db.SmartReadings.FirstOrDefaultAsync(
                s => s.CabinetId == group.Key.CabinetId &&
                     s.DriveSerial == group.Key.Serial &&
                     s.IsAggregated &&
                     s.TimestampUtc == group.Key.Day, ct);

            if (existing is null)
            {
                existing = new SmartReading
                {
                    CabinetId = group.Key.CabinetId,
                    DriveSerial = group.Key.Serial,
                    TimestampUtc = group.Key.Day,
                    IsAggregated = true,
                    Health = rows[0].Health,
                    Source = SmartSource.Unavailable,
                };

                db.SmartReadings.Add(existing);
                written++;
            }

            existing.DriveModel ??= rows.Select(r => r.DriveModel).FirstOrDefault(m => m is not null);

            // The aggregate keeps the strongest source seen that day. Mixing a
            // structured counter with a decoded vendor byte under one label
            // would make the provenance field a lie.
            existing.Source = rows.Select(r => r.Source).Aggregate(existing.Source, BetterSource);

            existing.Health = rows.Select(r => r.Health).Aggregate(existing.Health, WorseDisk);
            existing.ReallocatedSectorCount = Max(existing.ReallocatedSectorCount, rows.Max(r => r.ReallocatedSectorCount));
            existing.PendingSectorCount = Max(existing.PendingSectorCount, rows.Max(r => r.PendingSectorCount));
            existing.UncorrectableErrorCount = Max(existing.UncorrectableErrorCount, rows.Max(r => r.UncorrectableErrorCount));
            existing.PowerOnHours = Max(existing.PowerOnHours, rows.Max(r => r.PowerOnHours));
            existing.TemperatureCelsius = Max(existing.TemperatureCelsius, rows.Max(r => r.TemperatureCelsius));
            existing.TemperatureMax = Max(existing.TemperatureMax, rows.Max(r => r.TemperatureMax));
            existing.StartStopCycleCount = Max(existing.StartStopCycleCount, rows.Max(r => r.StartStopCycleCount));
            existing.Wear = Max(existing.Wear, rows.Max(r => r.Wear));
            existing.ReadErrorsTotal = Max(existing.ReadErrorsTotal, rows.Max(r => r.ReadErrorsTotal));
            existing.ReadErrorsUncorrected = Max(existing.ReadErrorsUncorrected, rows.Max(r => r.ReadErrorsUncorrected));
            existing.WriteErrorsTotal = Max(existing.WriteErrorsTotal, rows.Max(r => r.WriteErrorsTotal));
            existing.WriteErrorsUncorrected = Max(existing.WriteErrorsUncorrected, rows.Max(r => r.WriteErrorsUncorrected));
            existing.OverallPredictFailure = Or(existing.OverallPredictFailure, rows.Select(r => r.OverallPredictFailure));
            existing.PredictFailureReason ??= rows
                .Select(r => r.PredictFailureReason)
                .FirstOrDefault(v => v is not null);

            db.SmartReadings.RemoveRange(rows);
        }

        await db.SaveChangesAsync(ct);
        return (written, due.Count);
    }

    private async Task<int> DeleteAgedSmartAggregatesAsync(
        SupportDbContext db, DateTimeOffset nowUtc, CancellationToken ct)
    {
        DateTimeOffset cutoff = nowUtc.AddDays(-_options.SmartAggregateRetentionDays);

        List<SmartReading> aged = await db.SmartReadings
            .Where(s => s.TimestampUtc < cutoff)
            .Take(_options.BatchSize)
            .ToListAsync(ct);

        if (aged.Count == 0)
        {
            return 0;
        }

        db.SmartReadings.RemoveRange(aged);
        await db.SaveChangesAsync(ct);
        return aged.Count;
    }

    /// <summary>
    /// Caps how many inventory versions one cabinet may hold, oldest first.
    /// </summary>
    /// <remarks>
    /// Inventory is a change history and is not aged out by time: a cabinet
    /// that has not changed in two years holds one row, and deleting it would
    /// lose the answer to "what is installed on this machine". The cap exists
    /// only for a cabinet that flaps between configurations. The version
    /// currently in force is never removed.
    /// </remarks>
    private async Task<int> TrimInventoryVersionsAsync(SupportDbContext db, CancellationToken ct)
    {
        List<Guid> crowded = await db.InventoryVersions
            .GroupBy(v => v.CabinetId)
            .Where(g => g.Count() > _options.MaxInventoryVersionsPerCabinet)
            .Select(g => g.Key)
            .Take(50)
            .ToListAsync(ct);

        if (crowded.Count == 0)
        {
            return 0;
        }

        var removed = 0;

        foreach (Guid cabinetId in crowded)
        {
            Guid? current = await db.Cabinets
                .Where(c => c.Id == cabinetId)
                .Select(c => c.CurrentInventoryVersionId)
                .FirstOrDefaultAsync(ct);

            List<InventoryVersion> excess = await db.InventoryVersions
                .Where(v => v.CabinetId == cabinetId && (current == null || v.Id != current))
                .OrderBy(v => v.LastObservedUtc)
                .Take(_options.BatchSize)
                .ToListAsync(ct);

            int keep = _options.MaxInventoryVersionsPerCabinet;
            int total = await db.InventoryVersions.CountAsync(v => v.CabinetId == cabinetId, ct);
            int toRemove = Math.Max(0, total - keep);

            if (toRemove == 0)
            {
                continue;
            }

            List<InventoryVersion> batch = excess.Take(toRemove).ToList();
            db.InventoryVersions.RemoveRange(batch);
            removed += batch.Count;
        }

        if (removed > 0)
        {
            await db.SaveChangesAsync(ct);
        }

        return removed;
    }

    private static DateTimeOffset TruncateToHour(DateTimeOffset value) =>
        new(value.Year, value.Month, value.Day, value.Hour, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset TruncateToDay(DateTimeOffset value) =>
        new(value.Year, value.Month, value.Day, 0, 0, 0, TimeSpan.Zero);

    /// <summary>
    /// Keeps the larger of two readings, treating null as "no reading" rather
    /// than as zero.
    /// </summary>
    private static T? Max<T>(T? left, T? right) where T : struct, IComparable<T> =>
        left is null ? right : right is null ? left : left.Value.CompareTo(right.Value) >= 0 ? left : right;

    private static T? Min<T>(T? left, T? right) where T : struct, IComparable<T> =>
        left is null ? right : right is null ? left : left.Value.CompareTo(right.Value) <= 0 ? left : right;

    private static double? MaxMagnitude(double? seed, IEnumerable<double?> values)
    {
        double? best = seed;

        foreach (double? value in values)
        {
            if (value is null)
            {
                continue;
            }

            if (best is null || Math.Abs(value.Value) > Math.Abs(best.Value))
            {
                best = value;
            }
        }

        return best;
    }

    /// <summary>
    /// True if any sample was true; null only if every sample was null. An hour
    /// in which a reboot was pending had a reboot pending.
    /// </summary>
    private static bool? Or(bool? seed, IEnumerable<Heartbeat> rows) =>
        Or(seed, rows.Select(r => r.RebootPending));

    private static bool? Or(bool? seed, IEnumerable<bool?> values)
    {
        bool? result = seed;

        foreach (bool? value in values)
        {
            if (value is null)
            {
                continue;
            }

            result = result is true || value is true;
        }

        return result;
    }

    /// <summary>
    /// Folds the logged-on flag conservatively: any true wins, and an unknown
    /// beats a false.
    /// </summary>
    /// <remarks>
    /// This value gates reboots. Folding an hour that contained one unreadable
    /// sample down to "nobody was logged on" would turn a missing reading into
    /// permission, which is the failure this whole codebase is arranged to
    /// prevent.
    /// </remarks>
    private static bool? OrLoggedOn(bool? seed, IEnumerable<Heartbeat> rows)
    {
        bool? result = seed;
        var sawUnknown = false;

        foreach (Heartbeat row in rows)
        {
            if (row.AnyUserLoggedOn is true)
            {
                return true;
            }

            if (row.AnyUserLoggedOn is null)
            {
                sawUnknown = true;
            }
            else
            {
                result ??= false;
            }
        }

        return result is true ? true : sawUnknown ? null : result;
    }

    private static DiskHealthStatus WorseDisk(DiskHealthStatus left, DiskHealthStatus right) =>
        DiskSeverity(left) >= DiskSeverity(right) ? left : right;

    private static int DiskSeverity(DiskHealthStatus status) => status switch
    {
        DiskHealthStatus.Healthy => 0,
        DiskHealthStatus.Unknown => 1,
        DiskHealthStatus.Watch => 2,
        DiskHealthStatus.Failing => 3,
        _ => 1,
    };

    /// <summary>
    /// Picks the more trustworthy of two sources: a structured reliability
    /// counter beats a status flag, which beats decoded vendor bytes.
    /// </summary>
    private static SmartSource BetterSource(SmartSource left, SmartSource right) =>
        SourceRank(left) >= SourceRank(right) ? left : right;

    private static int SourceRank(SmartSource source) => source switch
    {
        SmartSource.StorageReliabilityCounter => 3,
        SmartSource.FailurePredictStatus => 2,
        SmartSource.FailurePredictData => 1,
        _ => 0,
    };
}
