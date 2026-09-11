using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Contracts.Agent;

/// <summary>
/// One drive's SMART counters at one point in time. Every counter is nullable
/// because the set a drive exposes depends on its bus and firmware: a SATA
/// spinner reports reallocated sectors, an NVMe module reports available spare
/// and percentage used, and neither reports the other's attributes. A missing
/// counter must never be conflated with a zero counter — zero reallocated
/// sectors is good news, an absent reading is no news at all.
/// </summary>
public sealed class SmartSnapshot
{
    /// <summary>Stable per-drive identity; the key for trending a drive over time.</summary>
    public string DriveSerial { get; set; } = string.Empty;

    public string? DriveModel { get; set; }
    public string? FirmwareVersion { get; set; }

    /// <summary>Windows disk number / mount hint, for display only.</summary>
    public string? DeviceId { get; set; }

    public DateTime TimestampUtc { get; set; }

    /// <summary>The drive's own overall verdict, when it exposes one.</summary>
    public DiskHealthStatus PredictedHealth { get; set; } = DiskHealthStatus.Unknown;

    // --- Rotational / SATA attributes -----------------------------------
    public long? ReallocatedSectorCount { get; set; }
    public long? ReportedUncorrectableErrors { get; set; }
    public long? CommandTimeoutCount { get; set; }
    public long? CurrentPendingSectorCount { get; set; }
    public long? OfflineUncorrectableCount { get; set; }
    public long? UdmaCrcErrorCount { get; set; }
    public long? SpinRetryCount { get; set; }
    public long? SeekErrorRate { get; set; }
    public long? ReadErrorRate { get; set; }

    // --- Solid state / NVMe attributes -----------------------------------
    public long? WearLevelingCount { get; set; }
    public int? PercentageUsed { get; set; }
    public int? AvailableSparePercent { get; set; }
    public int? AvailableSpareThresholdPercent { get; set; }
    public long? MediaAndDataIntegrityErrors { get; set; }
    public long? UnsafeShutdownCount { get; set; }

    // --- Shared attributes -----------------------------------------------
    public long? PowerOnHours { get; set; }
    public long? PowerCycleCount { get; set; }
    public int? TemperatureCelsius { get; set; }
    public long? TotalHostReadsGb { get; set; }
    public long? TotalHostWritesGb { get; set; }
}
