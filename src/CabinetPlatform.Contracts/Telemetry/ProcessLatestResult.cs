using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Read-only display projection of one saved process-list action.</summary>
public sealed record ProcessLatestResult
{
    /// <summary>Cabinet identity from the selected action.</summary>
    public required Guid CabinetId { get; init; }
    /// <summary>Immutable action identity.</summary>
    public required Guid ActionId { get; init; }
    /// <summary>pending, failed, or complete. Completion is not a sampling timestamp.</summary>
    public required string State { get; init; }
    /// <summary>Server request time.</summary>
    public required DateTimeOffset RequestedAtUtc { get; init; }
    /// <summary>Agent-reported completion time, if present; not a sample instant.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public DateTimeOffset? CompletedAtUtc { get; init; }
    /// <summary>True when display rows were reduced to fit the projection limits.</summary>
    public required bool Truncated { get; init; }
    /// <summary>Validated and bounded display rows.</summary>
    public required IReadOnlyList<ProcessDisplayResult> Processes { get; init; }
}

/// <summary>Allowlisted counters only; no process selection or executable identity.</summary>
public sealed record ProcessDisplayResult
{
    /// <summary>Observed process image name, without path.</summary>
    public required string Name { get; init; }
    /// <summary>Observed operating system process identifier.</summary>
    public required int Pid { get; init; }
    /// <summary>Observed CPU percentage, or unknown.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public double? CpuPercent { get; init; }
    /// <summary>Observed working set bytes, or unknown.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? WorkingSetBytes { get; init; }
    /// <summary>Observed thread count, or unknown.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public int? ThreadCount { get; init; }
    /// <summary>Observed handle count, or unknown.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public int? HandleCount { get; init; }
}
