namespace CabinetPlatform.Contracts.Actions;

/// <summary>Identity captured when a process is selected, never a launch command.</summary>
public sealed record ProcessSelectionIdentity
{
    /// <summary>Operating system process identifier.</summary>
    public required int ProcessId { get; init; }
    /// <summary>Observed image name without path.</summary>
    public required string ProcessName { get; init; }

    /// <summary>Exact Windows creation FILETIME, not a rounded display timestamp.</summary>
    public required long CreationTimeFileTime { get; init; }

    /// <summary>Full image path as observed by Windows. Used only for comparison.</summary>
    public required string ExecutablePath { get; init; }
}
