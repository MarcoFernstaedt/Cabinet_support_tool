using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Domain;

/// <summary>
/// One heartbeat: the small fixed sample a cabinet sends every few minutes.
/// </summary>
/// <remarks>
/// <para>
/// Stored as typed columns and no JSON document. Seven thousand cabinets at a
/// five-minute cadence is about two million rows a day; a stored payload per
/// row reaches terabytes within weeks, and none of it would ever be read,
/// because every list and aggregate this server serves reads these columns.
/// </para>
/// <para>
/// Every counter is nullable, and that is the point. A counter the agent could
/// not read is null; writing zero would read as an idle machine and would
/// poison the trend the fleet view is built from.
/// </para>
/// </remarks>
public class Heartbeat
{
    /// <summary>Identifier of the row.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Cabinet this sample came from.</summary>
    public Guid CabinetId { get; set; }

    /// <summary>Navigation to that cabinet.</summary>
    public Cabinet? Cabinet { get; set; }

    /// <summary>UTC instant the server received it.</summary>
    public DateTimeOffset ReceivedUtc { get; set; }

    /// <summary>
    /// UTC instant the agent assembled it. Doubles as the idempotency key with
    /// the cabinet id: a retried sample must not create a second row.
    /// </summary>
    public DateTimeOffset CollectedAtUtc { get; set; }

    /// <summary>Version of the agent that produced it.</summary>
    public string? AgentVersion { get; set; }

    /// <summary>Seconds since the cabinet last booted.</summary>
    public double? UptimeSeconds { get; set; }

    /// <summary>Total CPU utilisation across all cores, as a percentage.</summary>
    public double? CpuPercent { get; set; }

    /// <summary>Physical memory in use, as a percentage.</summary>
    public double? RamUsedPercent { get; set; }

    /// <summary>Free space on the tightest volume, as a percentage.</summary>
    public double? MinFreeDiskPercent { get; set; }

    /// <summary>Worst drive health across the cabinet's disks.</summary>
    public DiskHealthStatus WorstDiskHealth { get; set; } = DiskHealthStatus.Unknown;

    /// <summary>
    /// Whether anyone was signed in. Null means the agent could not tell, and
    /// is treated as unsafe to reboot — identically to true.
    /// </summary>
    public bool? AnyUserLoggedOn { get; set; }

    /// <summary>Updates detected and not installed, or null if the scan did not complete.</summary>
    public int? PendingUpdateCount { get; set; }

    /// <summary>Whether a reboot is pending to finish an installation.</summary>
    public bool? RebootPending { get; set; }

    /// <summary>
    /// Difference between the cabinet's own clock and the server's. Drift
    /// breaks site synchronisation and audit correlation alike, so it is
    /// measured on every sample rather than investigated after a complaint.
    /// </summary>
    public double? ClockDriftSeconds { get; set; }

    /// <summary>Collectors that could not complete, and why, as a JSON object.</summary>
    public string SectionErrorsJson { get; set; } = "{}";

    /// <summary>
    /// True when this row is an hourly roll-up of samples older than the
    /// full-resolution window rather than a single sample.
    /// </summary>
    public bool IsAggregated { get; set; }

    /// <summary>How many samples an aggregate row stands for. One for a real sample.</summary>
    public int SampleCount { get; set; } = 1;
}

/// <summary>
/// One stored version of a cabinet's inventory: what was installed, running and
/// configured at the moment it last changed.
/// </summary>
/// <remarks>
/// Stored as a change history, not a snapshot per check-in. The agent sends
/// inventory every six hours; the server hashes the content and writes nothing
/// when the hash matches the version in force. A cabinet nobody touches for a
/// year holds one row here, not fourteen hundred.
/// </remarks>
public class InventoryVersion
{
    /// <summary>Identifier of the version.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Cabinet this inventory belongs to.</summary>
    public Guid CabinetId { get; set; }

    /// <summary>Navigation to that cabinet.</summary>
    public Cabinet? Cabinet { get; set; }

    /// <summary>
    /// Hash over the inventory content. Equality here is what makes an
    /// unchanged check-in a no-op.
    /// </summary>
    public string ContentHash { get; set; } = string.Empty;

    /// <summary>UTC instant this version was first observed.</summary>
    public DateTimeOffset FirstObservedUtc { get; set; }

    /// <summary>UTC instant it was last confirmed still in force.</summary>
    public DateTimeOffset LastObservedUtc { get; set; }

    /// <summary>
    /// The inventory sections verbatim, in the shared wire convention, so they
    /// can still be read by any component years from now. Never deserialised by
    /// a list or aggregate query — only when one cabinet's detail is opened.
    /// </summary>
    public string PayloadJson { get; set; } = string.Empty;

    /// <summary>Collectors that could not complete, and why, as a JSON object.</summary>
    public string SectionErrorsJson { get; set; } = "{}";
}

/// <summary>
/// One drive's SMART counters at one point in time.
/// </summary>
/// <remarks>
/// Always stored, never skipped, even when identical to the previous reading:
/// this is the failure-prediction time series the whole system exists to
/// produce, and a gap in it is a gap in the trend. Every counter is nullable,
/// and <see cref="Source"/> records which WMI class produced it, because a
/// structured reliability counter and a value decoded out of a vendor-specific
/// byte array are not the same measurement.
/// </remarks>
public class SmartReading
{
    /// <summary>Identifier of the reading.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Cabinet the drive is in.</summary>
    public Guid CabinetId { get; set; }

    /// <summary>Navigation to that cabinet.</summary>
    public Cabinet? Cabinet { get; set; }

    /// <summary>Stable per-drive identity; the key for trending one drive over time.</summary>
    public string DriveSerial { get; set; } = string.Empty;

    /// <summary>Drive model string.</summary>
    public string? DriveModel { get; set; }

    /// <summary>UTC instant the reading was taken on the cabinet.</summary>
    public DateTimeOffset TimestampUtc { get; set; }

    /// <summary>Health derived from the counters.</summary>
    public DiskHealthStatus Health { get; set; } = DiskHealthStatus.Unknown;

    /// <summary>Which WMI source the counters came from.</summary>
    public SmartSource Source { get; set; } = SmartSource.Unavailable;

    /// <summary>Count of sectors reallocated after a read or write failure.</summary>
    public int? ReallocatedSectorCount { get; set; }

    /// <summary>Count of unstable sectors awaiting reallocation.</summary>
    public int? PendingSectorCount { get; set; }

    /// <summary>Count of errors the drive could not correct.</summary>
    public int? UncorrectableErrorCount { get; set; }

    /// <summary>Cumulative powered-on hours.</summary>
    public int? PowerOnHours { get; set; }

    /// <summary>Current drive temperature, in degrees Celsius.</summary>
    public int? TemperatureCelsius { get; set; }

    /// <summary>The drive's own failure prediction flag.</summary>
    public bool? OverallPredictFailure { get; set; }

    /// <summary>Vendor reason code accompanying the prediction flag.</summary>
    public int? PredictFailureReason { get; set; }

    /// <summary>Percentage of rated write endurance consumed.</summary>
    public int? Wear { get; set; }

    /// <summary>Total read errors, corrected ones included.</summary>
    public long? ReadErrorsTotal { get; set; }

    /// <summary>Read errors the drive could not correct.</summary>
    public long? ReadErrorsUncorrected { get; set; }

    /// <summary>Total write errors, corrected ones included.</summary>
    public long? WriteErrorsTotal { get; set; }

    /// <summary>Write errors the drive could not correct.</summary>
    public long? WriteErrorsUncorrected { get; set; }

    /// <summary>Highest temperature the drive has recorded.</summary>
    public int? TemperatureMax { get; set; }

    /// <summary>Number of start-stop cycles completed.</summary>
    public int? StartStopCycleCount { get; set; }

    /// <summary>
    /// True when this row is a daily roll-up of readings older than the
    /// full-resolution window, holding that day's worst observed value for each
    /// counter.
    /// </summary>
    public bool IsAggregated { get; set; }
}
