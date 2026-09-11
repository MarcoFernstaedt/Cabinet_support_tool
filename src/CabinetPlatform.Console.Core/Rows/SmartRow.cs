using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>
/// One drive's SMART counters at one moment, with every counter rendered as
/// text so an absent reading stays visibly absent.
/// </summary>
/// <remarks>
/// A SATA spinner reports reallocated sectors and never reports available
/// spare; an NVMe module is the other way round. Rendering a missing counter as
/// zero would put "0 reallocated sectors" — a clean bill of health — against
/// every NVMe drive in the fleet.
/// </remarks>
public sealed class SmartRow
{
    public SmartRow(SmartReadingDto reading)
    {
        Reading = reading;
        Health = StatusPresentation.ForDisk(reading.PredictedHealth);
    }

    public SmartReadingDto Reading { get; }

    public string DriveSerial => Format.Text(Reading.DriveSerial);
    public string DriveModel => Format.Text(Reading.DriveModel);
    public DateTime TimestampUtc => Reading.TimestampUtc;
    public string Timestamp => Format.LocalTime(Reading.TimestampUtc);

    public StatusPresentation Health { get; }

    /// <summary>
    /// A daily roll-up of readings that have aged past full resolution. Shown
    /// because a trend line built from a mix of the two is otherwise silently
    /// misleading about how often the drive was sampled.
    /// </summary>
    public bool IsAggregated => Reading.IsAggregated;

    public string Resolution => Reading.IsAggregated ? "Daily average" : "As sampled";

    public string ReallocatedSectors => Format.Count(Reading.ReallocatedSectorCount);
    public string PendingSectors => Format.Count(Reading.CurrentPendingSectorCount);
    public string OfflineUncorrectable => Format.Count(Reading.OfflineUncorrectableCount);
    public string ReportedUncorrectable => Format.Count(Reading.ReportedUncorrectableErrors);
    public string CommandTimeouts => Format.Count(Reading.CommandTimeoutCount);
    public string CrcErrors => Format.Count(Reading.UdmaCrcErrorCount);
    public string SpinRetries => Format.Count(Reading.SpinRetryCount);
    public string SeekErrorRate => Format.Count(Reading.SeekErrorRate);
    public string ReadErrorRate => Format.Count(Reading.ReadErrorRate);

    public string WearLevelling => Format.Count(Reading.WearLevelingCount);
    public string PercentageUsed => Reading.PercentageUsed is null
        ? Format.NotReported
        : Format.Percent(Reading.PercentageUsed);
    public string AvailableSpare => Reading.AvailableSparePercent is null
        ? Format.NotReported
        : Format.Percent(Reading.AvailableSparePercent);
    public string AvailableSpareThreshold => Reading.AvailableSpareThresholdPercent is null
        ? Format.NotReported
        : Format.Percent(Reading.AvailableSpareThresholdPercent);
    public string MediaErrors => Format.Count(Reading.MediaAndDataIntegrityErrors);
    public string UnsafeShutdowns => Format.Count(Reading.UnsafeShutdownCount);

    public string PowerOnHours => Format.Count(Reading.PowerOnHours);
    public string PowerCycles => Format.Count(Reading.PowerCycleCount);
    public string Temperature => Reading.TemperatureCelsius is null
        ? Format.NotReported
        : $"{Reading.TemperatureCelsius} °C";
    public string HostReads => Reading.TotalHostReadsGb is null
        ? Format.NotReported
        : $"{Format.Count(Reading.TotalHostReadsGb)} GB";
    public string HostWrites => Reading.TotalHostWritesGb is null
        ? Format.NotReported
        : $"{Format.Count(Reading.TotalHostWritesGb)} GB";

    public string AccessibleSummary =>
        $"{Timestamp}. Drive {DriveSerial}. Health {Health.Label}. " +
        $"Reallocated sectors {ReallocatedSectors}. Pending sectors {PendingSectors}. " +
        $"Percentage used {PercentageUsed}. Temperature {Temperature}. {Resolution}.";
}
