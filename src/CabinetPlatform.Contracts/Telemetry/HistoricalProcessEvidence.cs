namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>A read is evidence only for retained records, not historical audit policy.</summary>
public enum ProcessEvidenceStatus
{
    /// <summary>No observation.</summary>
    Unknown = 0,
    /// <summary>The bounded query reached its end.</summary>
    Read = 1,
    /// <summary>Query incomplete or record(s) rejected.</summary>
    Partial = 2,
    /// <summary>Access denied before any valid row.</summary>
    Denied = 3,
    /// <summary>Source or probe unavailable.</summary>
    Unavailable = 4
}
/// <summary>Reported event kind, not an inferred process lifetime.</summary>
public enum ProcessEventKind
{
    /// <summary>Event 4688.</summary>
    Start = 1,
    /// <summary>Event 4689.</summary>
    Exit = 2
}

/// <summary>Bounded local Security event observation.</summary>
public sealed record HistoricalProcessEvidenceResult
{
    /// <summary>Wire schema version.</summary>
    public int Version { get; init; } = 1;
    /// <summary>Observation instant in UTC.</summary>
    public DateTimeOffset ObservedUtc { get; init; }
    /// <summary>Inclusive fixed-window beginning in UTC.</summary>
    public DateTimeOffset WindowStartUtc { get; init; }
    /// <summary>Read completeness, not audit-policy coverage.</summary>
    public ProcessEvidenceStatus Status { get; init; }
    /// <summary>Audit policy and historical coverage are not collected by this action.</summary>
    public bool AuditCoverageVerified => false;
    /// <summary>True when bounded query was cut short.</summary>
    public bool Truncated { get; init; }
    /// <summary>Individual unpaired event clues.</summary>
    public IReadOnlyList<HistoricalProcessEvent> Events { get; init; } = [];
}

/// <summary>Only timestamp, kind, numeric PID and optional local record number; no image identity or causal claim.</summary>
public sealed record HistoricalProcessEvent
{
    /// <summary>Event timestamp in UTC.</summary>
    public DateTimeOffset OccurredUtc { get; init; }
    /// <summary>Single recorded event kind.</summary>
    public ProcessEventKind Kind { get; init; }
    /// <summary>Numeric process ID; may have been reused.</summary>
    public uint ProcessId { get; init; }
    /// <summary>Opaque local event record number, not a globally unique identity.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)]
    public long? RecordId { get; init; }
}
