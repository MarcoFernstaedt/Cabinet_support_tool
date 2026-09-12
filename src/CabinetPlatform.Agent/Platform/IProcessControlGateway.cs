using System.ComponentModel;
using System.Diagnostics;

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
/// Everything here goes through <see cref="Process"/>. Nothing shells out to
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
    /// The whole reason a kill-by-id carries an expected name. Ids are reused
    /// within minutes on a busy machine, so this is read immediately before
    /// acting and compared with what the request believed.
    /// </remarks>
    /// <param name="processId">The process id.</param>
    string? GetProcessName(int processId);

    /// <summary>Process ids currently running under one image name.</summary>
    /// <param name="processName">The image name, without path or extension.</param>
    IReadOnlyList<int> GetProcessIds(string processName);

    /// <summary>
    /// Ends one process and waits for it to exit.
    /// </summary>
    /// <param name="processId">The process id.</param>
    /// <param name="timeout">How long to wait for the exit.</param>
    /// <returns>True when the process is gone.</returns>
    bool Kill(int processId, TimeSpan timeout);

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
