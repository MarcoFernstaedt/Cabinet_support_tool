using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// A single Windows event log record collected from a cabinet PC.
/// </summary>
/// <remarks>
/// These are observations: the platform noticed that Windows recorded
/// something. They are never conflated with records of actions the platform
/// itself caused, which are audited separately as
/// <see cref="Audit.AuditEntryDto"/> with
/// <see cref="Audit.AuditEventKind.Caused"/>.
/// </remarks>
public sealed record EventLogEntry
{
    /// <summary>Which Windows log the record came from.</summary>
    public required EventLogName LogName { get; init; }

    /// <summary>Provider or source name that wrote the record.</summary>
    public string? Source { get; init; }

    /// <summary>Windows event identifier.</summary>
    public required int EventId { get; init; }

    /// <summary>Severity level of the record.</summary>
    public required EventLogLevel Level { get; init; }

    /// <summary>UTC instant the record was written.</summary>
    public required DateTimeOffset TimeCreatedUtc { get; init; }

    /// <summary>Rendered message text, or <see langword="null"/> if it could not be rendered.</summary>
    public string? Message { get; init; }
}

/// <summary>
/// The Windows logs this platform collects from.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum EventLogName
{
    /// <summary>The Application log.</summary>
    Application = 1,

    /// <summary>The System log.</summary>
    System = 2,

    /// <summary>The Security log.</summary>
    Security = 3,
}

/// <summary>
/// Severity level of an event log record.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum EventLogLevel
{
    /// <summary>The level could not be determined.</summary>
    Unknown = 0,

    /// <summary>Verbose or trace detail.</summary>
    Verbose = 1,

    /// <summary>Informational.</summary>
    Information = 2,

    /// <summary>Warning.</summary>
    Warning = 3,

    /// <summary>Error.</summary>
    Error = 4,

    /// <summary>Critical failure.</summary>
    Critical = 5,
}
