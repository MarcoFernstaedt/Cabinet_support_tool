using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// Windows Update state: what is pending, what was installed, and the policy
/// that governs when installation may happen.
/// </summary>
public sealed record WindowsUpdateInfo
{
    /// <summary>Updates detected as applicable and not yet installed.</summary>
    public IReadOnlyList<PendingUpdateInfo>? PendingUpdates { get; init; }

    /// <summary>
    /// Number of pending updates as reported by Windows. Left
    /// <see langword="null"/> when the scan did not complete; zero means a
    /// completed scan found nothing.
    /// </summary>
    public int? PendingUpdateCount { get; init; }

    /// <summary>UTC instant of the last successful update installation.</summary>
    public DateTimeOffset? LastSuccessfulInstallUtc { get; init; }

    /// <summary>Whether a reboot is pending to finish an installation.</summary>
    public bool? RebootPending { get; init; }

    /// <summary>Recent update installation history.</summary>
    public IReadOnlyList<UpdateHistoryEntry>? History { get; init; }

    /// <summary>
    /// Start of the machine's configured active hours, in machine local time.
    /// Windows will not restart automatically inside this window.
    /// </summary>
    public TimeOnly? ActiveHoursStart { get; init; }

    /// <summary>End of the machine's configured active hours, in machine local time.</summary>
    public TimeOnly? ActiveHoursEnd { get; init; }

    /// <summary>Whether update behaviour is controlled by group policy or an MDM.</summary>
    public bool? IsManagedByPolicy { get; init; }

    /// <summary>Configured deferral period for updates, in days.</summary>
    public int? DeferralDays { get; init; }
}

/// <summary>
/// An update detected as applicable but not yet installed.
/// </summary>
public sealed record PendingUpdateInfo
{
    /// <summary>Windows Update identifier for the update.</summary>
    public required string UpdateId { get; init; }

    /// <summary>Update title as published.</summary>
    public string? Title { get; init; }

    /// <summary>Classification Windows assigns to the update.</summary>
    public required UpdateClassification Classification { get; init; }

    /// <summary>
    /// Whether the update carries a security fix. Kept separate from
    /// <see cref="Classification"/> because a security fix can ship inside a
    /// rollup or a driver package.
    /// </summary>
    public bool? IsSecurity { get; init; }

    /// <summary>Download size, in bytes.</summary>
    public long? SizeBytes { get; init; }
}

/// <summary>
/// One entry from the machine's update installation history.
/// </summary>
public sealed record UpdateHistoryEntry
{
    /// <summary>Title of the update the entry refers to.</summary>
    public string? Title { get; init; }

    /// <summary>Outcome Windows recorded for the operation.</summary>
    public required UpdateResultCode ResultCode { get; init; }

    /// <summary>UTC instant the operation completed.</summary>
    public DateTimeOffset? DateUtc { get; init; }

    /// <summary>Windows error code for a failed operation, or <see langword="null"/> when there was none.</summary>
    public int? ErrorCode { get; init; }
}

/// <summary>
/// Classification Windows assigns to an update.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UpdateClassification
{
    /// <summary>The classification could not be determined or is not one this platform models.</summary>
    Unknown = 0,

    /// <summary>Security update.</summary>
    SecurityUpdate = 1,

    /// <summary>Critical update.</summary>
    CriticalUpdate = 2,

    /// <summary>General update.</summary>
    Update = 3,

    /// <summary>Update rollup.</summary>
    UpdateRollup = 4,

    /// <summary>Service pack.</summary>
    ServicePack = 5,

    /// <summary>Feature pack.</summary>
    FeaturePack = 6,

    /// <summary>Definition update, such as antimalware definitions.</summary>
    DefinitionUpdate = 7,

    /// <summary>Device driver.</summary>
    Driver = 8,

    /// <summary>Tool.</summary>
    Tool = 9,

    /// <summary>Operating system upgrade.</summary>
    Upgrade = 10,

    /// <summary>Application.</summary>
    Application = 11,
}

/// <summary>
/// Outcome Windows recorded for an update operation.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UpdateResultCode
{
    /// <summary>The outcome could not be determined.</summary>
    Unknown = 0,

    /// <summary>The operation has not started.</summary>
    NotStarted = 1,

    /// <summary>The operation is in progress.</summary>
    InProgress = 2,

    /// <summary>The operation succeeded.</summary>
    Succeeded = 3,

    /// <summary>The operation completed with errors.</summary>
    SucceededWithErrors = 4,

    /// <summary>The operation failed.</summary>
    Failed = 5,

    /// <summary>The operation was aborted.</summary>
    Aborted = 6,
}
