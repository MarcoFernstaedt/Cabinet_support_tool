namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Outcome of enumerating the local machine's registered event channels.</summary>
public enum EventChannelDiscoveryStatus
{
    /// <summary>Enumeration succeeded, subject to the truncation flag.</summary>
    Available,
    /// <summary>The agent identity could not enumerate channels.</summary>
    AccessDenied,
    /// <summary>Discovery was unsupported or failed.</summary>
    Unavailable,
}

/// <summary>Observed read access, not a promise that a later read will succeed.</summary>
public enum EventChannelAccess
{
    /// <summary>A read-only probe succeeded, including an empty log.</summary>
    Readable,
    /// <summary>The channel is disabled. Discovery leaves it disabled.</summary>
    Disabled,
    /// <summary>The agent identity was refused access.</summary>
    AccessDenied,
    /// <summary>The channel disappeared, is unsupported or could not be queried.</summary>
    Unavailable,
}

/// <summary>A native channel name and the result of a read-only access probe.</summary>
public sealed record EventChannelInfo
{
    /// <summary>Exact local Windows channel name, not an XPath or file path.</summary>
    public required string Name { get; init; }
    /// <summary>Read access observed during discovery.</summary>
    public required EventChannelAccess Access { get; init; }
}

/// <summary>
/// Bounded, on-demand discovery. Truncated or unsuccessful results are not a complete inventory.
/// Discovery neither enables channels nor changes permissions or audit policy.
/// </summary>
public sealed record EventChannelDiscoveryResult
{
    /// <summary>Whether enumeration succeeded; individual channels can still be inaccessible.</summary>
    public EventChannelDiscoveryStatus Status { get; init; } = EventChannelDiscoveryStatus.Unavailable;
    /// <summary>Observed channels, with explicit per-channel access outcomes.</summary>
    public IReadOnlyList<EventChannelInfo> Channels { get; init; } = Array.Empty<EventChannelInfo>();
    /// <summary>The discovery work or payload limit was reached. More channels may exist.</summary>
    public bool Truncated { get; init; }
}
