using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One running process, as the last on-demand fetch saw it.</summary>
/// <remarks>
/// PID and name are displayed diagnostics, not sufficient authorization. Selected
/// termination also requires the exact creation FILETIME and full image path
/// observed through one retained handle; inaccessible identities remain nullable.
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

    /// <summary>The nullable identity observed through one process handle.</summary>
    public CabinetPlatform.Contracts.Actions.ProcessSelectionIdentity? SelectionIdentity => Info.SelectionIdentity;

    /// <summary>Only a complete identity consistent with the displayed row can be submitted.</summary>
    public bool HasCompleteSelectionIdentity => SelectionIdentity is { } identity &&
        identity.ProcessId > 0 && identity.ProcessId != 4 && identity.ProcessId == Pid &&
        identity.CreationTimeFileTime > 0 && !string.IsNullOrWhiteSpace(identity.ProcessName) &&
        string.Equals(identity.ProcessName, Name, StringComparison.OrdinalIgnoreCase) &&
        CabinetPlatform.Contracts.Actions.ProcessSelectionIdentity.IsValidExecutablePath(identity.ExecutablePath);

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
        $"{Name}, process id {Pid}. CPU {Cpu}. Memory {Memory}. Threads {Threads}. " +
        (HasCompleteSelectionIdentity
            ? "Observed identity available. Selected termination still requires server and agent permission."
            : "Process identity unavailable. Selected termination is disabled; refresh the process list.");
}
