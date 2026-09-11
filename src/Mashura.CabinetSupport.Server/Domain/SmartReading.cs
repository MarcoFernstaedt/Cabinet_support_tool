using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Server.Domain;

/// <summary>
/// One drive's SMART counters at one point in time, in its own table so that
/// drive-failure trending stays fast and can be retained far longer than the
/// check-in rows it arrived with.
///
/// Every counter is nullable: the attributes a drive exposes depend on its bus
/// and firmware, and "this drive does not report reallocated sectors" must
/// never be stored as "this drive reports zero reallocated sectors".
/// </summary>
public class SmartReading
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid CabinetId { get; set; }
    public Cabinet? Cabinet { get; set; }

    public string DriveSerial { get; set; } = string.Empty;
    public string? DriveModel { get; set; }
    public string? FirmwareVersion { get; set; }
    public string? DeviceId { get; set; }

    public DateTime TimestampUtc { get; set; }

    public DiskHealthStatus PredictedHealth { get; set; } = DiskHealthStatus.Unknown;

    /// <summary>
    /// True when retention has rolled a day's readings into a single row. The
    /// counters then hold that day's worst/highest observed values, which is
    /// the shape failure prediction needs from history.
    /// </summary>
    public bool IsAggregated { get; set; }

    /// <summary>Number of source readings folded into an aggregate row.</summary>
    public int SampleCount { get; set; } = 1;

    // --- Rotational / SATA -------------------------------------------------
    public long? ReallocatedSectorCount { get; set; }
    public long? ReportedUncorrectableErrors { get; set; }
    public long? CommandTimeoutCount { get; set; }
    public long? CurrentPendingSectorCount { get; set; }
    public long? OfflineUncorrectableCount { get; set; }
    public long? UdmaCrcErrorCount { get; set; }
    public long? SpinRetryCount { get; set; }
    public long? SeekErrorRate { get; set; }
    public long? ReadErrorRate { get; set; }

    // --- Solid state / NVMe ------------------------------------------------
    public long? WearLevelingCount { get; set; }
    public int? PercentageUsed { get; set; }
    public int? AvailableSparePercent { get; set; }
    public int? AvailableSpareThresholdPercent { get; set; }
    public long? MediaAndDataIntegrityErrors { get; set; }
    public long? UnsafeShutdownCount { get; set; }

    // --- Shared ------------------------------------------------------------
    public long? PowerOnHours { get; set; }
    public long? PowerCycleCount { get; set; }
    public int? TemperatureCelsius { get; set; }
    public long? TotalHostReadsGb { get; set; }
    public long? TotalHostWritesGb { get; set; }
}
