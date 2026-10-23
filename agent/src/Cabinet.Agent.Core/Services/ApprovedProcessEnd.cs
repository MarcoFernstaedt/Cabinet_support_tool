using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Services;

/// <summary>
/// process.end as the broker runs it (docs/spec/13-roadmap.md, milestone 10): the program running under that process ID
/// must be on this cabinet's approved list, its whole path re-checked against the entry before anything is ended. The
/// check is made here, in the privileged process, and never from the request: the network process cannot name a program
/// the server's list does not carry, and a process whose program cannot be read is refused rather than ended.
/// </summary>
public static class ApprovedProcessEnd
{
    /// <summary>
    /// Registers process.end with the approved list in front of <paramref name="end"/>.
    /// </summary>
    /// <param name="registry">The broker's operations.</param>
    /// <param name="approved">The approved list in force, read again for every request.</param>
    /// <param name="programOf">The whole program path of a running process, or null when Windows will not say.</param>
    /// <param name="end">What actually ends the process once it is approved.</param>
    /// <param name="log">The broker's log.</param>
    public static OperationRegistry Register(OperationRegistry registry, Func<ApprovedApps> approved, Func<long, string?> programOf, Func<ProcessEndParams, ProcessEndOutput> end, Action<string> log) =>
        registry.Replace<ProcessEndParams, ProcessEndOutput>(Catalog.ProcessEnd, (p, _) => Task.FromResult(Run(p, approved(), programOf, end, log)));

    /// <summary>The approved-list check, then the end. Throws <see cref="OperationFailedException"/> without ending anything when the program is not approved.</summary>
    public static ProcessEndOutput Run(ProcessEndParams p, ApprovedApps approved, Func<long, string?> programOf, Func<ProcessEndParams, ProcessEndOutput> end, Action<string> log)
    {
        approved.RefuseProcessEnd(p.ProcessId, p.Name, programOf(p.ProcessId));
        ProcessEndOutput output = end(p);
        log($"Process {p.Name} ({p.ProcessId}): ended (it is on the approved list).");
        return output;
    }
}
