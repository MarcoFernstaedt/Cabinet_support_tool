using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Platform;

/// <summary>A single opened process object, retained through inspection and termination.</summary>
public interface ISelectedProcessHandle : IDisposable
{
    /// <summary>Identity read from this handle, not a second lookup by PID.</summary>
    ProcessSelectionIdentity Identity { get; }
    /// <summary>Whether Windows marks this process critical. Unknown must throw.</summary>
    bool IsCritical { get; }
    /// <summary>Terminates only this process, never its descendants.</summary>
    void Terminate();
    /// <summary>Waits a bounded time for this same process object to exit.</summary>
    bool WaitForExit(TimeSpan timeout);
}

/// <summary>Opens a process once. Implementations must not reacquire the PID after opening.</summary>
public interface ISelectedProcessHandleFactory
{
    /// <summary>Opens query, terminate and synchronize access or fails without effects.</summary>
    ISelectedProcessHandle Open(int processId);
}

/// <summary>Termination was requested but the subsequent exit observation failed.</summary>
public sealed class ProcessExitUnconfirmedException : InvalidOperationException
{
    /// <summary>Preserves the wait error without claiming that termination failed.</summary>
    public ProcessExitUnconfirmedException(Exception inner)
        : base("Termination was requested, but exit was not confirmed. Refresh the process list before any further action.", inner) { }
}

/// <summary>Identity could not be verified, so no termination was attempted.</summary>
public sealed class ProcessIdentityMismatchException : InvalidOperationException
{
    /// <summary>Creates a refusal suitable for an action result.</summary>
    public ProcessIdentityMismatchException()
        : base("The selected process identity no longer matches. Refresh the process list. Nothing was ended.") { }
}
