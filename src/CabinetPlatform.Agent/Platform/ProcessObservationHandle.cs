using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Platform;

/// <summary>A retained process handle with observation access only.</summary>
public interface IProcessObservationHandle : IDisposable
{
    /// <summary>PID, image name, exact creation FILETIME and path from this same handle.</summary>
    ProcessSelectionIdentity Identity { get; }
}

/// <summary>Read-only discovery boundary. Does not request terminate or synchronize privileges.</summary>
public interface IProcessObservationHandleFactory
{
    /// <summary>Opens PROCESS_QUERY_LIMITED_INFORMATION, or throws without changing the process.</summary>
    IProcessObservationHandle OpenRead(int processId);
}
