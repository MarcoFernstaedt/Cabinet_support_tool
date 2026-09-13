using System.ComponentModel;
using System.Diagnostics;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Ending and starting processes on this machine.
/// </summary>
/// <remarks>
/// <para>
/// Separate from <see cref="IProcessProvider"/>, which only reads. The split is
/// not tidiness: the collectors take the reading interface and physically
/// cannot end anything, so the surface that can is small enough to review in
/// one sitting.
/// </para>
/// <para>
/// Operations use <see cref="Process"/> or retained Windows process handles. Nothing shells out to
/// <c>taskkill</c>, and nothing ever will: handing the agent a general
/// mechanism for launching programs with arguments would undo the property the
/// whole design rests on, which is that the agent has no such mechanism.
/// </para>
/// </remarks>
public interface IProcessControlGateway
{
    /// <summary>
    /// The image name Windows currently has for a process id, or null when no
    /// process holds that id.
    /// </summary>
    /// <remarks>
    /// Observation only. A separate name read cannot safely authorize a later
    /// kill by PID. Selected-process termination must use <see cref="KillSelected"/>.
    /// </remarks>
    /// <param name="processId">The process id.</param>
    string? GetProcessName(int processId);

    /// <summary>Process ids currently running under one image name.</summary>
    /// <param name="processName">The image name, without path or extension.</param>
    IReadOnlyList<int> GetProcessIds(string processName);

    /// <summary>
    /// Legacy bulk-action operation. Ends a process tree and waits for exit.
    /// </summary>
    /// <remarks>Not suitable for a selected process. Use <see cref="KillSelected"/> for identity binding.</remarks>
    /// <param name="processId">The process id.</param>
    /// <param name="timeout">How long to wait for the exit.</param>
    /// <returns>True when the process is gone.</returns>
    bool Kill(int processId, TimeSpan timeout);

    /// <summary>Checks the selected identity and terminates only that process through one retained handle.</summary>
    bool KillSelected(ProcessSelectionIdentity expected, TimeSpan timeout, CancellationToken cancellationToken);

    /// <summary>Starts an executable with no arguments and returns its process id.</summary>
    /// <remarks>
    /// No argument parameter, deliberately. The agent relaunches an application
    /// from its registered path; it does not run a command line, and there is
    /// nowhere in this interface for one to travel.
    /// </remarks>
    /// <param name="executablePath">The registered install path.</param>
    int Start(string executablePath);

    /// <summary>This agent's own process id.</summary>
    /// <remarks>
    /// Read from the running process rather than configured, so that the
    /// self-protection check cannot be defeated by a wrong configuration file.
    /// </remarks>
    int CurrentProcessId { get; }

    /// <summary>This agent's own image name.</summary>
    string CurrentProcessName { get; }
}

/// <summary>
/// Drives processes through <see cref="System.Diagnostics.Process"/>.
/// </summary>
public sealed class ProcessControlGateway : IProcessControlGateway
{
    private readonly ISelectedProcessHandleFactory _selectedHandles;

    /// <summary>Creates the native Windows gateway.</summary>
    public ProcessControlGateway() : this(new WindowsSelectedProcessHandleFactory()) { }

    /// <summary>Creates a gateway with an injectable process-object boundary.</summary>
    public ProcessControlGateway(ISelectedProcessHandleFactory selectedHandles) => _selectedHandles = selectedHandles;

    /// <inheritdoc />
    public bool KillSelected(ProcessSelectionIdentity expected, TimeSpan timeout, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromSeconds(30))
        {
            throw new ArgumentOutOfRangeException(nameof(timeout), "Exit wait must be greater than zero and at most 30 seconds.");
        }
        if (expected.ProcessId <= 0 || expected.ProcessId == 4 || expected.ProcessId == CurrentProcessId ||
            expected.CreationTimeFileTime <= 0 || string.IsNullOrWhiteSpace(expected.ProcessName) ||
            string.IsNullOrWhiteSpace(expected.ExecutablePath))
        {
            throw new ArgumentException("A complete, non-protected selected process identity is required.", nameof(expected));
        }
        using ISelectedProcessHandle handle = _selectedHandles.Open(expected.ProcessId);
        ProcessSelectionIdentity observed = handle.Identity;
        if (expected.ProcessId != observed.ProcessId ||
            expected.CreationTimeFileTime != observed.CreationTimeFileTime ||
            !string.Equals(expected.ExecutablePath, observed.ExecutablePath, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Actions.ProcessTargetPolicy.Normalise(expected.ProcessName),
                Actions.ProcessTargetPolicy.Normalise(observed.ProcessName), StringComparison.OrdinalIgnoreCase))
        {
            throw new ProcessIdentityMismatchException();
        }

        if (handle.IsCritical)
        {
            throw new InvalidOperationException("Windows marks the selected process critical. Nothing was ended.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        handle.Terminate();
        return handle.WaitForExit(timeout);
    }

    /// <inheritdoc />
    public int CurrentProcessId => Environment.ProcessId;

    /// <inheritdoc />
    public string CurrentProcessName
    {
        get
        {
            using Process current = Process.GetCurrentProcess();
            return current.ProcessName;
        }
    }

    /// <inheritdoc />
    public string? GetProcessName(int processId)
    {
        try
        {
            using Process process = Process.GetProcessById(processId);
            return process.ProcessName;
        }
        catch (ArgumentException)
        {
            // No process holds that id. Not an error: it is the answer.
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    /// <inheritdoc />
    public IReadOnlyList<int> GetProcessIds(string processName)
    {
        Process[] processes = Process.GetProcessesByName(processName);

        try
        {
            return processes.Select(p => p.Id).ToArray();
        }
        finally
        {
            foreach (Process process in processes)
            {
                process.Dispose();
            }
        }
    }

    /// <inheritdoc />
    public bool Kill(int processId, TimeSpan timeout)
    {
        try
        {
            using Process process = Process.GetProcessById(processId);

            // The whole tree, because the applications support ends here spawn
            // helpers — a PDF viewer's renderer, a report host's worker — and
            // leaving those behind means the application does not actually
            // restart and the rep asks again.
            process.Kill(entireProcessTree: true);

            return process.WaitForExit((int)timeout.TotalMilliseconds);
        }
        catch (ArgumentException)
        {
            // It exited between the read and the kill. The requested end state
            // is the actual state, so this is a success.
            return true;
        }
        catch (InvalidOperationException)
        {
            return true;
        }
    }

    /// <inheritdoc />
    public int Start(string executablePath)
    {
        var info = new ProcessStartInfo
        {
            FileName = executablePath,

            // False, so the path is handed to CreateProcess directly rather
            // than to the shell. ShellExecute would interpret the value —
            // resolving it against PATH, applying file associations, honouring
            // a URL scheme — and interpretation is the thing this design will
            // not have anywhere near a cabinet.
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(executablePath) ?? string.Empty,
        };

        Process process = Process.Start(info)
            ?? throw new InvalidOperationException(
                $"Windows did not return a process when starting '{executablePath}'.");

        try
        {
            return process.Id;
        }
        catch (Win32Exception)
        {
            return 0;
        }
        finally
        {
            process.Dispose();
        }
    }
}
