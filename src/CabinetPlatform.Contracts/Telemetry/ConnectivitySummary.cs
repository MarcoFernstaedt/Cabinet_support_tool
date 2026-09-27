namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Raw facts for three consecutive minute samples, not a ping event log or agent diagnosis.</summary>
public sealed record ConnectivitySummary
{
    /// <summary>Stable retry identity.</summary>
    public Guid Id { get; init; }
    /// <summary>Approved target-set revision.</summary>
    public Guid ConfigurationId { get; init; }
    /// <summary>Cabinet making the observations.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Registered observed cabinet.</summary>
    public Guid TargetCabinetId { get; init; }
    /// <summary>First measurement timestamp, never reception time.</summary>
    public DateTimeOffset FirstObservedUtc { get; init; }
    /// <summary>Last measurement timestamp.</summary>
    public DateTimeOffset LastObservedUtc { get; init; }
    /// <summary>ICMP echo replies received in the interval.</summary>
    public int SuccessCount { get; init; }
    /// <summary>Completed probes without an echo reply.</summary>
    public int FailureCount { get; init; }
    /// <summary>Local probe execution errors, not evidence of a remote outage.</summary>
    public int ErrorCount { get; init; }
    /// <summary>Consecutive failures at the start of the interval.</summary>
    public int LeadingFailures { get; init; }
    /// <summary>Consecutive failures at the end of the interval.</summary>
    public int TrailingFailures { get; init; }
    /// <summary>Longest uninterrupted failure run within the interval.</summary>
    public int MaximumFailureRun { get; init; }
    /// <summary>Most recent reply, or null when there was none.</summary>
    public DateTimeOffset? LastSuccessUtc { get; init; }
    /// <summary>Most recent completed nonreply, or null when there was none.</summary>
    public DateTimeOffset? LastFailureUtc { get; init; }
}

/// <summary>Server-classified link state with raw evidence available separately.</summary>
public sealed record ConnectivityLinkState
{
    /// <summary>Registered target cabinet.</summary>
    public Guid TargetCabinetId { get; init; }
    /// <summary>Server topology role.</summary>
    public bool IsSync { get; init; }
    /// <summary>Unknown, Reachable, Degraded or Unreachable. Not a firewall or application diagnosis.</summary>
    public string Condition { get; init; } = "Unknown";
    /// <summary>True for missing or older-than-five-minute measurements, regardless of reception.</summary>
    public bool IsStale { get; init; } = true;
    /// <summary>Latest accepted observation timestamp.</summary>
    public DateTimeOffset? ObservedUtc { get; init; }
    /// <summary>Server reception of that observation, not proof of current reachability.</summary>
    public DateTimeOffset? ReceivedUtc { get; init; }
    /// <summary>Last successful probe observation.</summary>
    public DateTimeOffset? LastSuccessUtc { get; init; }
    /// <summary>Uninterrupted known failures, reset by success, error or a sampling gap.</summary>
    public int ConsecutiveFailures { get; init; }
    /// <summary>Whether a repeated-failure incident remains unresolved.</summary>
    public bool IncidentOpen { get; init; }
    /// <summary>Threshold-crossing failure time when retained by the aggregate; null when its exact time is unknown. Not outage onset.</summary>
    public DateTimeOffset? IncidentObservedUtc { get; init; }
    /// <summary>Server time when the most recent incident was detected.</summary>
    public DateTimeOffset? IncidentReceivedUtc { get; init; }
    /// <summary>Success observation resolving the most recent incident.</summary>
    public DateTimeOffset? RecoveredObservedUtc { get; init; }
}

/// <summary>Unmodified received aggregate and its server reception timestamp.</summary>
public sealed record ConnectivityEvidenceDto(ConnectivitySummary Summary, DateTimeOffset ReceivedUtc);

/// <summary>Bounded office monitoring read model; never a substitute for application sync health.</summary>
public sealed record ConnectivityStatusDto
{
    /// <summary>The source cabinet.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Configured active links, including links with no evidence.</summary>
    public IReadOnlyList<ConnectivityLinkState> Links { get; init; } = Array.Empty<ConnectivityLinkState>();
    /// <summary>At most 40 most recent aggregates, newest first. Not the complete retained history.</summary>
    public IReadOnlyList<ConnectivityEvidenceDto> RecentEvidence { get; init; } = Array.Empty<ConnectivityEvidenceDto>();
}
