using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One Windows service from the last check-in.</summary>
public sealed class ServiceRow
{
    /// <summary>Creates the row.</summary>
    /// <param name="snapshot">The service as the agent reported it.</param>
    public ServiceRow(ServiceInfo snapshot)
    {
        Snapshot = snapshot;
        State = StatusPresentation.ForServiceState(snapshot.State);
    }

    /// <summary>The service as the agent reported it.</summary>
    public ServiceInfo Snapshot { get; }

    /// <summary>Service short name, as the service control manager uses it.</summary>
    public string ServiceName => Snapshot.Name;

    /// <summary>Friendly name shown in Windows.</summary>
    public string DisplayName => Format.Text(Snapshot.DisplayName ?? Snapshot.Name);

    /// <summary>Configured start type, in words.</summary>
    public string StartMode => Snapshot.StartType.ToString();

    /// <summary>How the run state reads at a glance.</summary>
    public StatusPresentation State { get; }

    /// <summary>Whether the service is running.</summary>
    public bool IsRunning => Snapshot.State == ServiceState.Running;

    /// <summary>Whether the service is stopped. Unknown is neither.</summary>
    public bool IsStopped => Snapshot.State == ServiceState.Stopped;

    private bool IsAutoStart =>
        Snapshot.StartType is ServiceStartType.Automatic or ServiceStartType.AutomaticDelayed;

    /// <summary>
    /// Set to auto-start and not running. This is the preset support staff
    /// actually reach for: it is the shape of nearly every "the cabinet came
    /// back from a reboot but the dispense app never started" call.
    /// </summary>
    public bool IsAutoStartButStopped => IsAutoStart && IsStopped;

    /// <summary>One sentence a screen reader announces for this row.</summary>
    public string AccessibleSummary =>
        $"{DisplayName}. Service name {ServiceName}. State {State.Label}. Start mode {StartMode}." +
        (IsAutoStartButStopped ? " Set to start automatically but currently stopped." : string.Empty);
}
