using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Services;

/// <summary>
/// One running process, opened once and held open: the program it runs is read from this same handle and the end is
/// made through it, so a process ID Windows reuses between the check and the end cannot point the end at another
/// program. While the handle is open Windows cannot give its process ID to anything else.
/// </summary>
public interface IOpenedProcess : IDisposable
{
    /// <summary>The whole program path of the process this handle holds, or null when Windows will not say.</summary>
    string? Program { get; }

    /// <summary>Ends this process (the one held open), with the same name checks as before. Throws <see cref="OperationFailedException"/> when it is refused.</summary>
    ProcessEndOutput End(ProcessEndParams p);
}

/// <summary>
/// process.end as the broker runs it (docs/spec/13-roadmap.md, milestone 10): the program running under that process ID
/// must be on this cabinet's approved list, its whole path re-checked against the entry before anything is ended. The
/// check is made here, in the privileged process, against the program read from the process itself and never from the
/// request, and a process whose program cannot be read is refused rather than ended.
///
/// The list it checks against is the cabinet's copy, which the network service writes (ApprovedAppsFile): it keeps a
/// request to what the console approved, and it is a guard rail rather than a wall against a network service that has
/// been taken over (docs/spec/09-open-decisions.md).
/// </summary>
public static class ApprovedProcessEnd
{
    /// <summary>
    /// Registers process.end with the approved list in front of the end.
    /// </summary>
    /// <param name="registry">The broker's operations.</param>
    /// <param name="approved">The approved list in force, read again for every request.</param>
    /// <param name="open">Opens the process under that ID and holds it open, or returns null when there is none.</param>
    /// <param name="log">The broker's log.</param>
    public static OperationRegistry Register(OperationRegistry registry, Func<ApprovedApps> approved, Func<long, IOpenedProcess?> open, Action<string> log) =>
        registry.Replace<ProcessEndParams, ProcessEndOutput>(Catalog.ProcessEnd, (p, _) => Task.FromResult(Run(p, approved(), open, log)));

    /// <summary>The approved-list check, then the end, through one opened process. Throws <see cref="OperationFailedException"/> without ending anything when the program is not approved.</summary>
    public static ProcessEndOutput Run(ProcessEndParams p, ApprovedApps approved, Func<long, IOpenedProcess?> open, Action<string> log)
    {
        using IOpenedProcess process = open(p.ProcessId) ?? throw new OperationFailedException("not_found", "No process has that ID any more.");
        approved.RefuseProcessEnd(p.ProcessId, p.Name, process.Program);
        ProcessEndOutput output = process.End(p);
        log($"Process {p.Name} ({p.ProcessId}): ended (it is on the approved list).");
        return output;
    }
}
