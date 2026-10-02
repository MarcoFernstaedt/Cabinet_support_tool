namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Only machine stores are read. Values match REPORT_STORE_TYPES in werapi.h.</summary>
public enum WerStore
{
    /// <summary>Machine archive of sent reports.</summary>
    MachineArchive = 2,
    /// <summary>Machine queue of unsent reports.</summary>
    MachineQueue = 3
}

/// <summary>Outcome of a single store read.</summary>
public enum WerStoreStatus
{
    /// <summary>No observation.</summary>
    Unknown = 0,
    /// <summary>Enumeration finished.</summary>
    Read = 1,
    /// <summary>Incomplete read or bound reached.</summary>
    Partial = 2,
    /// <summary>Access refused.</summary>
    Denied = 3,
    /// <summary>Native source unavailable.</summary>
    Unavailable = 4
}

/// <summary>Fixed schema. No signature parameters, report keys, paths or files.</summary>
public sealed record WerMetadataResult
{
    /// <summary>Wire version.</summary>
    public int Version { get; init; } = 1;
    /// <summary>Agent observation time in UTC.</summary>
    public DateTimeOffset ObservedUtc { get; init; }
    /// <summary>Per-store completeness.</summary>
    public IReadOnlyList<WerStoreObservation> Stores { get; init; } = [];
    /// <summary>Approved recent rows.</summary>
    public IReadOnlyList<WerReportObservation> Reports { get; init; } = [];
}

/// <summary>One store read outcome.</summary>
public sealed record WerStoreObservation
{
    /// <summary>Machine store.</summary>
    public WerStore Store { get; init; }
    /// <summary>Read state.</summary>
    public WerStoreStatus Status { get; init; }
    /// <summary>Enumeration exceeded the cooperative budget or row/key cap.</summary>
    public bool Truncated { get; init; }
}

/// <summary>Allowlisted event type and non-content report identity.</summary>
public sealed record WerReportObservation
{
    /// <summary>Locally unique WER report ID.</summary>
    public Guid ReportId { get; init; }
    /// <summary>WER creation time in UTC.</summary>
    public DateTimeOffset CreatedUtc { get; init; }
    /// <summary>Compiled allowlisted event name, not raw signature text.</summary>
    public string EventType { get; init; } = string.Empty;
    /// <summary>Store in which the report was found.</summary>
    public WerStore Store { get; init; }
}
