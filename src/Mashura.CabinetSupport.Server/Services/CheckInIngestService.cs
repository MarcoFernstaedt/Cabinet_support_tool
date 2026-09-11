using System.Text.Json;
using Mashura.CabinetSupport.Contracts.Agent;
using Mashura.CabinetSupport.Contracts.Enums;
using Mashura.CabinetSupport.Server.Auditing;
using Mashura.CabinetSupport.Server.Configuration;
using Mashura.CabinetSupport.Server.Data;
using Mashura.CabinetSupport.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Mashura.CabinetSupport.Server.Services;

public sealed record CheckInIngestOutcome(bool WasDuplicate, CheckIn CheckIn);

public interface ICheckInIngestService
{
    Task<OperationResult<CheckInIngestOutcome>> IngestAsync(
        Cabinet cabinet, CheckInRequest request, CancellationToken ct);
}

/// <summary>
/// Turns one agent observation into a stored check-in, its SMART readings and
/// an Observed audit record, in a single transaction.
/// </summary>
public sealed class CheckInIngestService : ICheckInIngestService
{
    // The payload is stored verbatim in the shared wire convention, so it can
    // still be deserialised by any component years from now.
    private static readonly JsonSerializerOptions PayloadJsonOptions =
        Contracts.Common.ContractJson.CreateOptions();

    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly AgentIngestOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<CheckInIngestService> _logger;

    public CheckInIngestService(
        SupportDbContext db,
        IAuditService audit,
        IOptions<AgentIngestOptions> options,
        TimeProvider timeProvider,
        ILogger<CheckInIngestService> logger)
    {
        _db = db;
        _audit = audit;
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    public async Task<OperationResult<CheckInIngestOutcome>> IngestAsync(
        Cabinet cabinet, CheckInRequest request, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;
        DateTime collectedUtc = Normalise(request.CollectedAtUtc);

        if (collectedUtc > nowUtc.AddMinutes(_options.MaxClockSkewMinutes))
        {
            // A sample from the future is a broken clock or a replay attempt.
            // Either way it must not land in a trend a technician will read.
            return OperationResult<CheckInIngestOutcome>.Invalid(
                "CollectedAtUtc is implausibly far in the future.");
        }

        // Idempotency. Agents retry over flaky clinic networks, and a retried
        // sample must be acknowledged, not stored twice.
        CheckIn? existing = await _db.CheckIns
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.CabinetId == cabinet.Id && c.CollectedAtUtc == collectedUtc, ct);

        if (existing is not null)
        {
            return OperationResult<CheckInIngestOutcome>.Ok(new CheckInIngestOutcome(true, existing));
        }

        var checkIn = new CheckIn
        {
            CabinetId = cabinet.Id,
            ReceivedUtc = nowUtc,
            CollectedAtUtc = collectedUtc,
            PayloadJson = JsonSerializer.Serialize(request, PayloadJsonOptions),
            CpuPercent = Clamp(request.CpuPercent),
            RamUsedPercent = Clamp(request.RamUsedPercent),
            MinFreeDiskPercent = MinFreeDiskPercent(request),
            PendingUpdateCount = request.PendingUpdates?.Count ?? 0,
            WorstDiskHealth = WorstDiskHealth(request),
            AnyUserLoggedOn = request.AnyUserLoggedOn
        };

        _db.CheckIns.Add(checkIn);

        foreach (SmartSnapshot snapshot in request.SmartReadings ?? new List<SmartSnapshot>())
        {
            if (string.IsNullOrWhiteSpace(snapshot.DriveSerial))
            {
                // Without a stable serial there is nothing to trend the row
                // against, so it is dropped rather than stored unattributable.
                _logger.LogDebug(
                    "Dropped a SMART snapshot with no drive serial from cabinet {CabinetId}.", cabinet.Id);
                continue;
            }

            _db.SmartReadings.Add(ToReading(cabinet.Id, snapshot, collectedUtc));
        }

        cabinet.LastCheckInUtc = nowUtc;

        if (!string.IsNullOrWhiteSpace(request.AgentVersion))
        {
            cabinet.AgentVersion = request.AgentVersion.Trim();
        }

        if (!string.IsNullOrWhiteSpace(request.Hostname))
        {
            // The agent may legitimately report a renamed host. It still
            // cannot touch ClientName, SiteName or Department — those are the
            // approving Supervisor's to set.
            cabinet.Hostname = request.Hostname.Trim();
        }

        // A check-in changed nothing on the cabinet; the server merely saw it.
        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.AgentCheckIn,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.Agent,
            ActorId = cabinet.MachineId,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            Details = new
            {
                CheckInId = checkIn.Id,
                checkIn.CollectedAtUtc,
                checkIn.CpuPercent,
                checkIn.RamUsedPercent,
                checkIn.MinFreeDiskPercent,
                checkIn.PendingUpdateCount,
                WorstDiskHealth = checkIn.WorstDiskHealth.ToString(),
                checkIn.AnyUserLoggedOn,
                SmartReadingCount = request.SmartReadings?.Count ?? 0
            }
        });

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // Two retries of the same sample raced past the check above. The
            // unique index is the real guarantee; this just turns the race
            // into the same answer the first request got. Anything that is not
            // that race is a real failure and is rethrown untouched.
            _db.ChangeTracker.Clear();

            CheckIn? stored = await _db.CheckIns
                .AsNoTracking()
                .FirstOrDefaultAsync(
                    c => c.CabinetId == cabinet.Id && c.CollectedAtUtc == collectedUtc, ct);

            if (stored is null)
            {
                throw;
            }

            return OperationResult<CheckInIngestOutcome>.Ok(new CheckInIngestOutcome(true, stored));
        }

        return OperationResult<CheckInIngestOutcome>.Ok(new CheckInIngestOutcome(false, checkIn));
    }

    private static SmartReading ToReading(Guid cabinetId, SmartSnapshot s, DateTime fallbackUtc) => new()
    {
        CabinetId = cabinetId,
        DriveSerial = s.DriveSerial.Trim(),
        DriveModel = s.DriveModel,
        FirmwareVersion = s.FirmwareVersion,
        DeviceId = s.DeviceId,
        TimestampUtc = s.TimestampUtc == default ? fallbackUtc : Normalise(s.TimestampUtc),
        PredictedHealth = s.PredictedHealth,
        ReallocatedSectorCount = s.ReallocatedSectorCount,
        ReportedUncorrectableErrors = s.ReportedUncorrectableErrors,
        CommandTimeoutCount = s.CommandTimeoutCount,
        CurrentPendingSectorCount = s.CurrentPendingSectorCount,
        OfflineUncorrectableCount = s.OfflineUncorrectableCount,
        UdmaCrcErrorCount = s.UdmaCrcErrorCount,
        SpinRetryCount = s.SpinRetryCount,
        SeekErrorRate = s.SeekErrorRate,
        ReadErrorRate = s.ReadErrorRate,
        WearLevelingCount = s.WearLevelingCount,
        PercentageUsed = s.PercentageUsed,
        AvailableSparePercent = s.AvailableSparePercent,
        AvailableSpareThresholdPercent = s.AvailableSpareThresholdPercent,
        MediaAndDataIntegrityErrors = s.MediaAndDataIntegrityErrors,
        UnsafeShutdownCount = s.UnsafeShutdownCount,
        PowerOnHours = s.PowerOnHours,
        PowerCycleCount = s.PowerCycleCount,
        TemperatureCelsius = s.TemperatureCelsius,
        TotalHostReadsGb = s.TotalHostReadsGb,
        TotalHostWritesGb = s.TotalHostWritesGb
    };

    /// <summary>
    /// The tightest volume on the machine. A cabinet with a comfortable C: and
    /// a full data partition is a cabinet about to stop recording dispenses,
    /// so the minimum is what the fleet view needs, not the average.
    /// </summary>
    private static double MinFreeDiskPercent(CheckInRequest request)
    {
        List<VolumeSnapshot> volumes = request.Volumes ?? new List<VolumeSnapshot>();

        var sized = volumes.Where(v => v.TotalBytes > 0).ToList();

        return sized.Count == 0 ? 100d : Clamp(sized.Min(v => v.FreePercent));
    }

    private static DiskHealthStatus WorstDiskHealth(CheckInRequest request)
    {
        List<SmartSnapshot> readings = request.SmartReadings ?? new List<SmartSnapshot>();

        return readings.Count == 0
            ? DiskHealthStatus.Unknown
            : readings.Max(r => r.PredictedHealth);
    }

    private static double Clamp(double value) => double.IsFinite(value) ? Math.Clamp(value, 0d, 100d) : 0d;

    /// <summary>
    /// Everything stored is UTC. A timestamp that arrived without a kind is
    /// taken at its word as UTC rather than reinterpreted through the server's
    /// local zone, which would silently shift every clinic in another country.
    /// </summary>
    private static DateTime Normalise(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
    };
}
