namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Bounded, read-only event view projection for a single cabinet.</summary>
public sealed record EventLogLatestResult
{
    /// <summary>Explicitly requested cabinet.</summary>
    public required Guid CabinetId { get; init; }
    /// <summary>Selected action request.</summary>
    public required Guid ActionId { get; init; }
    /// <summary>pending, failed, complete, or partial.</summary>
    public required string State { get; init; }
    /// <summary>Server request time.</summary>
    public required DateTimeOffset RequestedAtUtc { get; init; }
    /// <summary>Agent-reported completion time, when present.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)]
    public DateTimeOffset? CompletedAtUtc { get; init; }
    /// <summary>Saved view identity at request time.</summary>
    public required Guid ViewId { get; init; }
    /// <summary>Saved display name at request time.</summary>
    public required string ViewDisplayName { get; init; }
    /// <summary>Exact requested channel names.</summary>
    public required IReadOnlyList<string> RequestedChannels { get; init; }
    /// <summary>Requested provider names; empty means unrestricted.</summary>
    public required IReadOnlyList<string> RequestedProviders { get; init; }
    /// <summary>Per-channel read outcomes, not discovery probes.</summary>
    public required IReadOnlyList<EventLogChannelReadProjection> ChannelReads { get; init; }
    /// <summary>Agent or web projection record ceiling was reached.</summary>
    public required bool Truncated { get; init; }
    /// <summary>Bounded event records.</summary>
    public required IReadOnlyList<EventLogEntryProjection> Entries { get; init; }
}

/// <summary>Outcome of reading one requested channel.</summary>
public sealed record EventLogChannelReadProjection
{
    /// <summary>Exact channel name.</summary>
    public required string ChannelName { get; init; }
    /// <summary>readable, disabled, accessDenied, or unavailable.</summary>
    public required string Outcome { get; init; }
    /// <summary>Records retained from the channel read.</summary>
    public required int RecordsRead { get; init; }
    /// <summary>Channel read was bounded before exhaustion.</summary>
    public required bool Truncated { get; init; }
}

/// <summary>Only display fields from a validated event record.</summary>
public sealed record EventLogEntryProjection
{
    /// <summary>Exact native channel or legacy channel label.</summary>
    public required string Channel { get; init; }
    /// <summary>Provider name, if known.</summary>
    public string? Provider { get; init; }
    /// <summary>Severity label.</summary>
    public required string Level { get; init; }
    /// <summary>Windows event identifier.</summary>
    public required int EventId { get; init; }
    /// <summary>Event occurrence timestamp.</summary>
    public required DateTimeOffset OccurredAt { get; init; }
    /// <summary>Rendered event message if available.</summary>
    public string? Message { get; init; }
}
