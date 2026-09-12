using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>
/// One drive's SMART counters at one moment, with every counter rendered as
/// text so an absent reading stays visibly absent.
/// </summary>
/// <remarks>
/// <para>
/// Which counters a drive reports depends on where they were read from. The
/// structured reliability counters give wear and error totals; the vendor byte
/// array gives reallocated and pending sectors and nothing else. Rendering a
/// missing counter as zero would put "0 reallocated sectors" — a clean bill of
/// health — against every drive whose controller does not expose them.
/// </para>
/// <para>
/// The source is shown alongside the numbers, because a structured counter and
/// a value decoded out of vendor bytes are not the same measurement even when
/// they carry the same name.
/// </para>
/// </remarks>
public sealed class SmartRow
{
    /// <summary>Creates the row.</summary>
    /// <param name="reading">The reading as the server stored it.</param>
    public SmartRow(SmartReadingDto reading)
    {
        Reading = reading;
        Health = StatusPresentation.ForDisk(reading.Health);
    }

    /// <summary>The reading as the server stored it.</summary>
    public SmartReadingDto Reading { get; }

    /// <summary>Stable per-drive identity.</summary>
    public string DriveSerial => Format.Text(Reading.DriveSerial);

    /// <summary>Drive model string.</summary>
    public string DriveModel => Format.Text(Reading.DriveModel);

    /// <summary>When the reading was taken, for ordering a trend.</summary>
    public DateTimeOffset TimestampUtc => Reading.TimestampUtc;

    /// <summary>When it was taken, in the reader's own zone.</summary>
    public string Timestamp => Format.LocalTime(Reading.TimestampUtc);

    /// <summary>How the drive's health reads at a glance.</summary>
    public StatusPresentation Health { get; }

    /// <summary>
    /// Which WMI source produced these counters.
    /// </summary>
    /// <remarks>
    /// Shown rather than hidden: a reading decoded from a vendor-specific byte
    /// array deserves a different amount of confidence from a documented
    /// reliability counter, and only the row itself can say which it is.
    /// </remarks>
    public string Source => Reading.Source switch
    {
        SmartSource.StorageReliabilityCounter => "Storage reliability counters",
        SmartSource.FailurePredictStatus => "Drive failure-prediction status",
        SmartSource.FailurePredictData => "Decoded vendor attributes",
        _ => "No source answered",
    };

    /// <summary>
    /// A daily roll-up of readings that have aged past full resolution. Shown
    /// because a trend line built from a mix of the two is otherwise silently
    /// misleading about how often the drive was sampled.
    /// </summary>
    public bool IsAggregated => Reading.IsAggregated;

    /// <summary>Whether this row is a sample or a roll-up, in words.</summary>
    public string Resolution => Reading.IsAggregated ? "Daily worst" : "As sampled";

    /// <summary>Sectors reallocated after a read or write failure.</summary>
    public string ReallocatedSectors => Format.Count(Reading.Smart.ReallocatedSectorCount);

    /// <summary>Unstable sectors awaiting reallocation.</summary>
    public string PendingSectors => Format.Count(Reading.Smart.PendingSectorCount);

    /// <summary>Errors the drive could not correct.</summary>
    public string UncorrectableErrors => Format.Count(Reading.Smart.UncorrectableErrorCount);

    /// <summary>Total read errors, corrected ones included.</summary>
    public string ReadErrorsTotal => Format.Count(Reading.Smart.ReadErrorsTotal);

    /// <summary>Read errors the drive could not correct.</summary>
    public string ReadErrorsUncorrected => Format.Count(Reading.Smart.ReadErrorsUncorrected);

    /// <summary>Total write errors, corrected ones included.</summary>
    public string WriteErrorsTotal => Format.Count(Reading.Smart.WriteErrorsTotal);

    /// <summary>Write errors the drive could not correct.</summary>
    public string WriteErrorsUncorrected => Format.Count(Reading.Smart.WriteErrorsUncorrected);

    /// <summary>Percentage of rated write endurance consumed.</summary>
    public string Wear => Reading.Smart.Wear is null
        ? Format.NotReported
        : Format.Percent(Reading.Smart.Wear);

    /// <summary>Start-stop cycles completed.</summary>
    public string StartStopCycles => Format.Count(Reading.Smart.StartStopCycleCount);

    /// <summary>Cumulative powered-on hours.</summary>
    public string PowerOnHours => Format.Count(Reading.Smart.PowerOnHours);

    /// <summary>Current temperature.</summary>
    public string Temperature => Reading.Smart.TemperatureCelsius is null
        ? Format.NotReported
        : $"{Reading.Smart.TemperatureCelsius} °C";

    /// <summary>Highest temperature the drive has recorded.</summary>
    public string TemperatureMax => Reading.Smart.TemperatureMax is null
        ? Format.NotReported
        : $"{Reading.Smart.TemperatureMax} °C";

    /// <summary>
    /// The drive's own verdict, when it gives one, and the vendor reason code
    /// beside it.
    /// </summary>
    public string PredictedFailure => Reading.Smart.OverallPredictFailure switch
    {
        true when Reading.Smart.PredictFailureReason is { } reason =>
            $"Yes — the drive predicts its own failure (vendor reason {reason})",
        true => "Yes — the drive predicts its own failure",
        false => "No",
        null => Format.NotReported,
    };

    /// <summary>One sentence a screen reader announces for this row.</summary>
    public string AccessibleSummary =>
        $"{Timestamp}. Drive {DriveSerial}. Health {Health.Label}. Source: {Source}. " +
        $"Reallocated sectors {ReallocatedSectors}. Pending sectors {PendingSectors}. " +
        $"Wear {Wear}. Temperature {Temperature}. {Resolution}.";
}
