using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Telemetry;

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

    /// <summary>Creates the row.</summary>
    /// <param name="snapshot">The volume as the agent reported it.</param>
    public VolumeRow(DiskInfo snapshot)
    {
        Snapshot = snapshot;

        // A volume whose free space could not be read is Unknown, never
        // "sufficient": the absence of a reading is not good news.
        Space = snapshot.FreePercent switch
        {
            null => StatusPresentation.Unknown,
            < CriticalFreePercent => new StatusPresentation("Critically low", "✖", StatusSeverity.Critical),
            < WarningFreePercent => new StatusPresentation("Low", "▲", StatusSeverity.Warning),
            _ => new StatusPresentation("Sufficient", "✔", StatusSeverity.Good),
        };
    }

    /// <summary>The volume as the agent reported it.</summary>
    public DiskInfo Snapshot { get; }

    /// <summary>Drive letter, as Windows reports it.</summary>
    public string VolumeId => Format.Text(Snapshot.DriveLetter);

    /// <summary>Volume label.</summary>
    public string Label => Format.Text(Snapshot.Label);

    /// <summary>File system name.</summary>
    public string FileSystem => Format.Text(Snapshot.FileSystem);

    /// <summary>BitLocker protection state, in words.</summary>
    public string BitLocker => Snapshot.BitLockerStatus.ToString();

    /// <summary>
    /// Free space as a percentage, or "not reported" when the agent could not
    /// read it. Never rendered as 0%: a missing reading is not a full disk.
    /// </summary>
    public string FreePercent => Snapshot.FreePercent is { } percent
        ? Format.Percent(percent)
        : Format.NotReported;

    /// <summary>Free space in bytes, or "not reported".</summary>
    public string FreeBytes => Snapshot.FreeBytes is { } free
        ? Format.Bytes(free)
        : Format.NotReported;

    /// <summary>Capacity in bytes, or "not reported".</summary>
    public string TotalBytes => Snapshot.TotalBytes is { } total
        ? Format.Bytes(total)
        : Format.NotReported;

    /// <summary>How the free space reads at a glance.</summary>
    public StatusPresentation Space { get; }

    /// <summary>One sentence a screen reader announces for this row.</summary>
    public string AccessibleSummary =>
        $"Volume {VolumeId}{(Label == Format.NotReported ? string.Empty : $", labelled {Label}")}. " +
        $"{FreeBytes} free of {TotalBytes}, {FreePercent}. Free space {Space.Label}.";
}
