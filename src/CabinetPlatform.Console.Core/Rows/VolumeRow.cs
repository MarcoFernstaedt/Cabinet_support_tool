using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Agent;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One disk volume and how much room is left on it.</summary>
public sealed class VolumeRow
{
    /// <summary>
    /// Thresholds for the free-space warning. These are the console's own
    /// reading of a number the server already stores; they change the words
    /// beside the figure and nothing else. Every decision that matters — the
    /// cabinet's rolled-up health, whether an action may run — is the server's.
    /// </summary>
    private const double CriticalFreePercent = 5d;
    private const double WarningFreePercent = 15d;

    public VolumeRow(VolumeSnapshot snapshot)
    {
        Snapshot = snapshot;

        Space = snapshot.TotalBytes <= 0
            ? StatusPresentation.Unknown
            : snapshot.FreePercent switch
            {
                < CriticalFreePercent => new StatusPresentation("Critically low", "✖", StatusSeverity.Critical),
                < WarningFreePercent => new StatusPresentation("Low", "▲", StatusSeverity.Warning),
                _ => new StatusPresentation("Sufficient", "✔", StatusSeverity.Good)
            };
    }

    public VolumeSnapshot Snapshot { get; }

    public string VolumeId => Format.Text(Snapshot.VolumeId);
    public string Label => Format.Text(Snapshot.Label);
    public string FileSystem => Format.Text(Snapshot.FileSystem);

    /// <summary>
    /// A volume reporting a zero or negative total is a failed reading, not a
    /// zero-byte disk, and is shown as unreported rather than as 0%.
    /// </summary>
    public string FreePercent => Snapshot.TotalBytes <= 0
        ? Format.NotReported
        : Format.Percent(Snapshot.FreePercent);

    public string FreeBytes => Snapshot.TotalBytes <= 0
        ? Format.NotReported
        : Format.Bytes(Snapshot.FreeBytes);

    public string TotalBytes => Snapshot.TotalBytes <= 0
        ? Format.NotReported
        : Format.Bytes(Snapshot.TotalBytes);

    public StatusPresentation Space { get; }

    public string AccessibleSummary =>
        $"Volume {VolumeId}{(Label == Format.NotReported ? string.Empty : $", labelled {Label}")}. " +
        $"{FreeBytes} free of {TotalBytes}, {FreePercent}. Free space {Space.Label}.";
}
