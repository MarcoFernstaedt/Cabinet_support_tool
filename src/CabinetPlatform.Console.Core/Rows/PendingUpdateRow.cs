using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One Windows update the cabinet has seen but not installed.</summary>
public sealed class PendingUpdateRow
{
    public PendingUpdateRow(PendingUpdateSnapshot snapshot)
    {
        Snapshot = snapshot;

        Classification = snapshot.IsSecurityUpdate
            ? new StatusPresentation("Security", "▲", StatusSeverity.Warning)
            : new StatusPresentation("Other", "○", StatusSeverity.Neutral);

        Reboot = snapshot.RequiresReboot
            ? new StatusPresentation("Reboot required", "▲", StatusSeverity.Warning)
            : new StatusPresentation("No reboot", "✔", StatusSeverity.Good);
    }

    public PendingUpdateSnapshot Snapshot { get; }

    public string UpdateId => Format.Text(Snapshot.UpdateId);
    public string Title => Format.Text(Snapshot.Title);

    public StatusPresentation Classification { get; }
    public StatusPresentation Reboot { get; }

    public string AccessibleSummary =>
        $"{Title}. {Classification.Label} update. {Reboot.Label}. Update identifier {UpdateId}.";
}
