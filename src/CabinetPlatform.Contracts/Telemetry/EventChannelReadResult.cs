namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Record read status, separate from point-in-time discovery access.</summary>
public sealed record EventChannelReadResult
{
    /// <summary>Exact requested local channel.</summary>
    public required string Name { get; init; }
    /// <summary>Actual read outcome, not a discovery promise.</summary>
    public required EventChannelAccess Access { get; init; }
    /// <summary>Records retained from this read before the cross-channel merge.</summary>
    public int RecordsRead { get; init; }
    /// <summary>The bounded read stopped before exhausting the channel.</summary>
    public bool Truncated { get; init; }
}
