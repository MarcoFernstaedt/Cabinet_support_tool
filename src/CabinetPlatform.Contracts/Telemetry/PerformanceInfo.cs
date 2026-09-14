namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// CPU, memory, page file and process counters sampled at collection time.
/// </summary>
/// <remarks>
/// Counters are nullable throughout. A counter that could not be sampled is
/// <see langword="null"/>; writing zero would read as "idle" and silently
/// corrupt any trend built on top of it.
/// </remarks>
public sealed record PerformanceInfo
{
    /// <summary>Total CPU utilisation across all cores, as a percentage from 0 to 100.</summary>
    public double? CpuTotalPercent { get; init; }

    /// <summary>
    /// Per-logical-core CPU utilisation, as percentages from 0 to 100, ordered
    /// by core index. Exposed as a read-only list so a payload cannot be
    /// mutated after it is built.
    /// </summary>
    public IReadOnlyList<double>? CpuPerCorePercent { get; init; }

    /// <summary>Total physical memory installed, in bytes.</summary>
    public long? RamTotalBytes { get; init; }

    /// <summary>Physical memory currently available, in bytes.</summary>
    public long? RamAvailableBytes { get; init; }

    /// <summary>Physical memory in use, as a percentage from 0 to 100.</summary>
    public double? RamUsedPercent { get; init; }

    /// <summary>Total page file capacity, in bytes.</summary>
    public long? PageFileTotalBytes { get; init; }

    /// <summary>Page file currently in use, in bytes.</summary>
    public long? PageFileUsedBytes { get; init; }

    /// <summary>Running processes, or <see langword="null"/> if they could not be enumerated.</summary>
    public IReadOnlyList<ProcessInfo>? Processes { get; init; }

    /// <summary>Programs configured to launch at logon or boot, or <see langword="null"/> if they could not be enumerated.</summary>
    public IReadOnlyList<StartupProgramInfo>? StartupPrograms { get; init; }
}

/// <summary>
/// A single running process as observed by the agent.
/// </summary>
public sealed record ProcessInfo
{
    /// <summary>Complete observed process identity, or null when inspection was unavailable.</summary>
    public Actions.ProcessSelectionIdentity? SelectionIdentity { get; init; }

    /// <summary>Process image name, without path.</summary>
    public required string Name { get; init; }

    /// <summary>Operating system process identifier.</summary>
    public required int Pid { get; init; }

    /// <summary>CPU utilisation attributed to this process, as a percentage from 0 to 100.</summary>
    public double? CpuPercent { get; init; }

    /// <summary>Working set size, in bytes.</summary>
    public long? WorkingSetBytes { get; init; }

    /// <summary>Thread count, or <see langword="null"/> if it could not be read.</summary>
    public int? ThreadCount { get; init; }

    /// <summary>Handle count, or <see langword="null"/> if it could not be read.</summary>
    public int? HandleCount { get; init; }
}

/// <summary>
/// A program registered to start automatically, as observed in the registry
/// run keys, startup folders or scheduled logon tasks.
/// </summary>
/// <remarks>
/// This is inbound observation only. <see cref="Command"/> is the string
/// Windows already holds for that entry; it is reported so support staff can
/// read it, and it is never executed, echoed back to an agent, or accepted as
/// input to an action. Actions are limited to
/// <see cref="Actions.ActionName"/> and carry no command text.
/// </remarks>
public sealed record StartupProgramInfo
{
    /// <summary>Name of the startup entry.</summary>
    public required string Name { get; init; }

    /// <summary>
    /// The command string Windows has recorded for the entry, for display
    /// only. The platform never executes this value.
    /// </summary>
    public string? Command { get; init; }

    /// <summary>Where the entry was found, for example the registry key path or startup folder.</summary>
    public string? Location { get; init; }
}
