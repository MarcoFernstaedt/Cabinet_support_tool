namespace CabinetPlatform.Agent.Platform;

/// <summary>One process as the agent can see it.</summary>
public sealed record ProcessSnapshot
{
    public required int Pid { get; init; }

    public required string Name { get; init; }

    public long? WorkingSetBytes { get; init; }

    public int? ThreadCount { get; init; }

    public int? HandleCount { get; init; }

    /// <summary>
    /// Total processor time consumed since the process started, or null when
    /// the agent was refused access to it.
    /// </summary>
    public TimeSpan? TotalProcessorTime { get; init; }
}

/// <summary>
/// Enumerates running processes. Abstracted so the performance collector's
/// arithmetic can be tested without spawning anything.
/// </summary>
public interface IProcessProvider
{
    /// <summary>
    /// Snapshots every process the agent can see.
    /// </summary>
    /// <remarks>
    /// Several system processes refuse access even to LocalSystem. That is
    /// normal and is handled per process: the process is still reported, with
    /// the fields that could not be read left null.
    /// </remarks>
    IReadOnlyList<ProcessSnapshot> GetProcesses();

    /// <summary>Number of logical processors, used to normalise CPU percentages.</summary>
    int ProcessorCount { get; }
}
