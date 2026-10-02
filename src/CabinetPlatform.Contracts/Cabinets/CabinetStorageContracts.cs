using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>Bounded historical storage evidence, not a current health verdict.</summary>
public sealed record CabinetStorageDto
{
    /// <summary>Requested cabinet identity.</summary>
    public required Guid CabinetId { get; init; }
    /// <summary>Server time when this projection was assembled.</summary>
    public required DateTimeOffset AsOfUtc { get; init; }
    /// <summary>Newest measured heartbeat, or null when absent.</summary>
    public StorageHeartbeatDto? Heartbeat { get; init; }
    /// <summary>At most 32 volume observations from the current inventory version.</summary>
    public required IReadOnlyList<StorageVolumeDto> Volumes { get; init; }
    /// <summary>At most 32 recent per-drive SMART observations.</summary>
    public required IReadOnlyList<StorageSmartDto> Smart { get; init; }
}

/// <summary>Storage fields of the newest heartbeat by collection time.</summary>
public sealed record StorageHeartbeatDto
{
    /// <summary>Agent measurement time.</summary>
    public required DateTimeOffset CollectedAtUtc { get; init; }
    /// <summary>Server receipt time, which may be much later.</summary>
    public required DateTimeOffset ReceivedUtc { get; init; }
    /// <summary>Minimum free percentage, null when not measured.</summary>
    public double? DiskFreePercent { get; init; }
    /// <summary>Worst observed disk health, Unknown is not Healthy.</summary>
    public required DiskHealthStatus WorstDiskHealth { get; init; }
}

/// <summary>Values belong to the version's first observation, not its latest confirmation.</summary>
public sealed record StorageVolumeDto
{
    /// <summary>Historical embedded free percentage; null when absent or invalid.</summary>
    public double? FreePercent { get; init; }
    /// <summary>First observation of this inventory version.</summary>
    public required DateTimeOffset ObservationFirstUtc { get; init; }
    /// <summary>Last confirmation of this inventory version, not a new space measurement.</summary>
    public required DateTimeOffset ObservationLastUtc { get; init; }
    /// <summary>Earliest possible timestamp of the embedded space value.</summary>
    public required DateTimeOffset EmbeddedValuesMeasuredAtUtc { get; init; }
}

/// <summary>One recent reading per reported serial; physical continuity is not verified.</summary>
public sealed record StorageSmartDto
{
    /// <summary>Cabinet-bound opaque selector for historical observations. Refresh the snapshot if invalidated by key rotation.</summary>
    public required string DriveSelector { get; init; }
    /// <summary>Agent measurement time, not server receipt.</summary>
    public required DateTimeOffset ObservedUtc { get; init; }
    /// <summary>Measured health or Unknown.</summary>
    public required DiskHealthStatus Health { get; init; }
    /// <summary>Typed SMART source.</summary>
    public required SmartSource Source { get; init; }
    /// <summary>Temperature in Celsius, if present.</summary>
    public int? TemperatureCelsius { get; init; }
    /// <summary>Hours powered on, if present.</summary>
    public int? PowerOnHours { get; init; }
    /// <summary>Rated write endurance consumed, if present.</summary>
    public int? WearPercent { get; init; }
    /// <summary>Reallocated sector count, if present.</summary>
    public int? ReallocatedSectors { get; init; }
    /// <summary>Pending sector count, if present.</summary>
    public int? PendingSectors { get; init; }
    /// <summary>Whether this is a daily retention rollup.</summary>
    public required bool Aggregated { get; init; }
}

/// <summary>Historical SMART observation. A serial groups observations, not guaranteed physical continuity.</summary>
public sealed record StorageTrendPoint
{
    /// <summary>Agent observation instant.</summary>
    public required DateTimeOffset ObservedUtc { get; init; }
    /// <summary>Exact raw heartbeat receipt, null when rolled or removed.</summary>
    public DateTimeOffset? ReceivedUtc { get; init; }
    /// <summary>Historical derived health.</summary>
    public required DiskHealthStatus Health { get; init; }
    /// <summary>Dominant historical source, not per-counter provenance.</summary>
    public required SmartSource Source { get; init; }
    /// <summary>Measured temperature, if present.</summary>
    public int? TemperatureCelsius { get; init; }
    /// <summary>Measured powered-on hours, if present.</summary>
    public int? PowerOnHours { get; init; }
    /// <summary>Measured wear, if present.</summary>
    public int? WearPercent { get; init; }
    /// <summary>Measured reallocated sectors, if present.</summary>
    public int? ReallocatedSectors { get; init; }
    /// <summary>Measured pending sectors, if present.</summary>
    public int? PendingSectors { get; init; }
    /// <summary>Daily retention rollup, not an individual raw reading.</summary>
    public required bool Aggregated { get; init; }
}

/// <summary>A bounded [from,to) page of retained SMART evidence. Late inserts and retention can change later pages.</summary>
public sealed record StorageTrendPage
{
    /// <summary>Requested cabinet.</summary>
    public required Guid CabinetId { get; init; }
    /// <summary>Inclusive UTC observation start.</summary>
    public required DateTimeOffset FromUtc { get; init; }
    /// <summary>Exclusive UTC observation end.</summary>
    public required DateTimeOffset ToUtc { get; init; }
    /// <summary>First-page server watermark for receipt metadata.</summary>
    public required DateTimeOffset AsOfUtc { get; init; }
    /// <summary>At most 50 retained rows.</summary>
    public required IReadOnlyList<StorageTrendPoint> Items { get; init; }
    /// <summary>Opaque continuation, null at the end. Retention may remove rows between pages.</summary>
    public string? NextCursor { get; init; }
}
