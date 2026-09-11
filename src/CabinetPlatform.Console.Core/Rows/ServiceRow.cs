using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Agent;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One Windows service from the last check-in.</summary>
public sealed class ServiceRow
{
    public ServiceRow(ServiceSnapshot snapshot)
    {
        Snapshot = snapshot;
        State = StatusPresentation.ForServiceState(snapshot.Status);
    }

    public ServiceSnapshot Snapshot { get; }

    public string ServiceName => Snapshot.ServiceName;
    public string DisplayName => Format.Text(Snapshot.DisplayName ?? Snapshot.ServiceName);
    public string StartMode => Format.Text(Snapshot.StartMode);

    public StatusPresentation State { get; }

    public bool IsRunning =>
        string.Equals(Snapshot.Status?.Trim(), "Running", StringComparison.OrdinalIgnoreCase);

    public bool IsStopped =>
        string.Equals(Snapshot.Status?.Trim(), "Stopped", StringComparison.OrdinalIgnoreCase);

    private bool IsAutoStart =>
        Snapshot.StartMode is { } mode &&
        mode.Replace(" ", string.Empty).StartsWith("Auto", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Set to auto-start and not running. This is the preset support staff
    /// actually reach for: it is the shape of nearly every "the cabinet came
    /// back from a reboot but the dispense app never started" call.
    /// </summary>
    public bool IsAutoStartButStopped => IsAutoStart && IsStopped;

    public string AccessibleSummary =>
        $"{DisplayName}. Service name {ServiceName}. State {State.Label}. Start mode {StartMode}." +
        (IsAutoStartButStopped ? " Set to start automatically but currently stopped." : string.Empty);
}
