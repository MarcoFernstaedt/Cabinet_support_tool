using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One Windows update the cabinet has seen but not installed.</summary>
public sealed class PendingUpdateRow
{
    /// <summary>Creates the row.</summary>
    /// <param name="snapshot">The update as the agent reported it.</param>
    public PendingUpdateRow(PendingUpdateInfo snapshot)
    {
        Snapshot = snapshot;

        // A security fix can ship inside a rollup or a driver package, so the
        // flag is read on its own rather than inferred from the classification.
        // Null is "not stated", which is not the same as "not a security fix".
        Classification = snapshot.IsSecurity switch
        {
            true => new StatusPresentation("Security", "▲", StatusSeverity.Warning),
            false => new StatusPresentation(snapshot.Classification.ToString(), "○", StatusSeverity.Neutral),
            null => new StatusPresentation(snapshot.Classification.ToString(), "○", StatusSeverity.Neutral),
        };
    }

    /// <summary>The update as the agent reported it.</summary>
    public PendingUpdateInfo Snapshot { get; }

    /// <summary>Windows Update identifier.</summary>
    public string UpdateId => Format.Text(Snapshot.UpdateId);

    /// <summary>Update title as published.</summary>
    public string Title => Format.Text(Snapshot.Title);

    /// <summary>Download size, or "not reported".</summary>
    public string SizeBytes => Snapshot.SizeBytes is { } size ? Format.Bytes(size) : Format.NotReported;

    /// <summary>How the classification reads at a glance.</summary>
    public StatusPresentation Classification { get; }

    /// <summary>One sentence a screen reader announces for this row.</summary>
    public string AccessibleSummary =>
        $"{Title}. {Classification.Label} update, {SizeBytes}. Update identifier {UpdateId}.";
}
