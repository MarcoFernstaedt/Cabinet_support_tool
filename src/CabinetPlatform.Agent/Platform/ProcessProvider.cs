using System.ComponentModel;
using System.Diagnostics;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Reads the process table through <see cref="Process"/>.
/// </summary>
public sealed class ProcessProvider : IProcessProvider
{
    private readonly IProcessObservationHandleFactory _observations;

    public ProcessProvider() : this(new WindowsSelectedProcessHandleFactory()) { }

    public ProcessProvider(IProcessObservationHandleFactory observations) => _observations = observations;

    public int ProcessorCount => Environment.ProcessorCount;

    public IReadOnlyList<ProcessSnapshot> GetProcesses()
    {
        var snapshots = new List<ProcessSnapshot>();

        foreach (var process in Process.GetProcesses())
        {
            try
            {
                snapshots.Add(Snapshot(process));
            }
            catch (Exception e) when (e is Win32Exception or InvalidOperationException or NotSupportedException or UnauthorizedAccessException)
            {
                // The process exited between enumeration and inspection, or is
                // protected. Neither is a collector failure.
            }
            finally
            {
                process.Dispose();
            }
        }

        return snapshots;
    }

    private ProcessSnapshot Snapshot(Process process)
    {
        // Name and id are readable for every process. Everything else may be
        // refused individually, and a refusal on one field must not cost the
        // fields that were readable.
        var snapshot = new ProcessSnapshot
        {
            Pid = process.Id,
            Name = process.ProcessName,
            WorkingSetBytes = TryRead(() => process.WorkingSet64),
            ThreadCount = TryRead(() => process.Threads.Count),
            HandleCount = TryRead(() => process.HandleCount),
            TotalProcessorTime = TryRead(() => process.TotalProcessorTime),
            SelectionIdentity = ReadIdentity(process.Id),
        };

        return snapshot;
    }

    private CabinetPlatform.Contracts.Actions.ProcessSelectionIdentity? ReadIdentity(int pid)
    {
        try
        {
            using IProcessObservationHandle handle = _observations.OpenRead(pid);
            return handle.Identity;
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException or NotSupportedException or UnauthorizedAccessException)
        {
            // Observation remains useful without identity. Never escalate access
            // to collect it, and never synthesize creation time from display time.
            return null;
        }
    }

    private static T? TryRead<T>(Func<T> read)
        where T : struct
    {
        try
        {
            return read();
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException or NotSupportedException or UnauthorizedAccessException)
        {
            // "Access is denied" on System, Registry, Secure System and the
            // protected antimalware process is expected on every Windows
            // machine. Reporting the field as unknown is the honest result.
            return null;
        }
    }
}
