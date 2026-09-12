using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One running process, as the last on-demand fetch saw it.</summary>
/// <remarks>
/// The process id is displayed prominently beside the name, and both travel
/// together into any action taken on the row. Ids are reused within minutes, so
/// the pair is the identification and either half alone is not.
/// </remarks>
public sealed class ProcessRow
{
    /// <summary>Creates the row.</summary>
    /// <param name="info">The process as the agent read it.</param>
    public ProcessRow(ProcessInfo info) => Info = info;

    /// <summary>The process as the agent read it.</summary>
    public ProcessInfo Info { get; }

    /// <summary>Image name, without path.</summary>
    public string Name => Info.Name;

    /// <summary>Operating system process identifier.</summary>
    public int Pid => Info.Pid;

    /// <summary>CPU attributed to this process, or a dash if it could not be read.</summary>
    public string Cpu => Format.Percent(Info.CpuPercent);

    /// <summary>Working set, or a dash if it could not be read.</summary>
    public string Memory => Format.Bytes(Info.WorkingSetBytes);

    /// <summary>Thread count, or a dash.</summary>
    public string Threads => Format.Count(Info.ThreadCount);

    /// <summary>Handle count, or a dash.</summary>
    public string Handles => Format.Count(Info.HandleCount);

    /// <summary>One sentence a screen reader announces for this row.</summary>
    public string AccessibleSummary =>
        $"{Name}, process id {Pid}. CPU {Cpu}. Memory {Memory}. Threads {Threads}.";
}
