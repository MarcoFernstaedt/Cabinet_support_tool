namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Accepted interval facts only. Null measurements mean retained evidence could not be trusted.</summary>
public sealed record ConnectivityHistoryItem
{
    /// <summary>Accepted evidence identity.</summary>
    public Guid Id { get; init; }
    /// <summary>Observing cabinet.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Observed cabinet.</summary>
    public Guid TargetCabinetId { get; init; }
    /// <summary>Approved target-set revision.</summary>
    public Guid ConfigurationId { get; init; }
    /// <summary>First probe observation.</summary>
    public DateTimeOffset FirstObservedUtc { get; init; }
    /// <summary>Last probe observation; the ordering key.</summary>
    public DateTimeOffset LastObservedUtc { get; init; }
    /// <summary>Server receipt, not current reachability.</summary>
    public DateTimeOffset ReceivedUtc { get; init; }
    /// <summary>Reply count, or null for unavailable evidence.</summary>
    public int? SuccessCount { get; init; }
    /// <summary>Nonreply count, or null for unavailable evidence.</summary>
    public int? FailureCount { get; init; }
    /// <summary>Local probe-error count, or null for unavailable evidence.</summary>
    public int? ErrorCount { get; init; }
    /// <summary>Last actual reply, if trusted and present.</summary>
    public DateTimeOffset? LastSuccessUtc { get; init; }
    /// <summary>Last completed nonreply, if trusted and present.</summary>
    public DateTimeOffset? LastFailureUtc { get; init; }
    /// <summary>Bounded source-side clue, not a firewall-cause verdict.</summary>
    public SourceFirewallCheck? SourceFirewallCheck { get; init; }
    /// <summary>Stored summary is corrupt or disagrees with accepted identity.</summary>
    public bool EvidenceUnavailable { get; init; }
}

/// <summary>Snapshot of retained accepted intervals; ingestion or retention may remove old rows between pages.</summary>
public sealed record ConnectivityHistoryPage
{
    /// <summary>Observing cabinet filter.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Optional observed-cabinet filter.</summary>
    public Guid? TargetCabinetId { get; init; }
    /// <summary>Server receipt watermark, pinned through pagination.</summary>
    public DateTimeOffset AsOfUtc { get; init; }
    /// <summary>Effective inclusive observation lower bound.</summary>
    public DateTimeOffset FromUtc { get; init; }
    /// <summary>Effective inclusive observation upper bound.</summary>
    public DateTimeOffset ToUtc { get; init; }
    /// <summary>At most the requested page size of accepted interval rows.</summary>
    public IReadOnlyList<ConnectivityHistoryItem> Items { get; init; } = [];
    /// <summary>Protected continuation token, or null at the end.</summary>
    public string? NextCursor { get; init; }
}
