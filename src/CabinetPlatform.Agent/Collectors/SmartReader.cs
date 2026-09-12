using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Reads SMART data for every physical drive, from the best source that answers.
/// </summary>
/// <remarks>
/// <para>
/// Three sources are tried in order, and they are not equivalent:
/// </para>
/// <list type="number">
/// <item>
/// <c>MSFT_StorageReliabilityCounter</c> in
/// <c>root\Microsoft\Windows\Storage</c>. Documented, structured, and named:
/// wear, read and write error totals, power-on hours, temperature and its
/// maximum, start-stop cycles. Preferred wherever it answers.
/// </item>
/// <item>
/// <c>MSStorageDriver_FailurePredictStatus</c> in <c>root\wmi</c>, for the
/// drive's own verdict and its reason code. No counters, but the verdict is
/// the single most actionable thing a drive reports.
/// </item>
/// <item>
/// <c>MSStorageDriver_FailurePredictData</c> in <c>root\wmi</c>, decoded from
/// a vendor-specific byte array. Last resort: the layout is, as the name says,
/// vendor specific, and the class is absent on USB-attached drives, on many
/// virtual machines, and wherever the vendor driver does not expose it.
/// </item>
/// </list>
/// <para>
/// Every source is correlated to a drive by its physical drive number, never by
/// the order rows come back in. When all three fail for a drive, its SMART is
/// null and its health is Unknown — never zeroed counters, which would read as
/// a pristine drive and poison the trend this system exists to produce.
/// </para>
/// </remarks>
public sealed class SmartReader
{
    private readonly IWmiRepository _wmi;
    private readonly ILogger<SmartReader> _logger;

    /// <summary>Creates the reader.</summary>
    /// <param name="wmi">The agent's view of WMI.</param>
    /// <param name="logger">Diagnostic log.</param>
    public SmartReader(IWmiRepository wmi, ILogger<SmartReader> logger)
    {
        _wmi = wmi;
        _logger = logger;
    }

    /// <summary>
    /// Reads what each drive will say about itself.
    /// </summary>
    /// <param name="disks">The physical drives, as Win32_DiskDrive described them.</param>
    /// <returns>
    /// One entry per drive that produced a reading, keyed by drive index. A
    /// drive absent from the result had nothing readable, which is a different
    /// statement from a drive with zeroed counters.
    /// </returns>
    public IReadOnlyDictionary<int, SmartInfo> Read(IReadOnlyList<PhysicalDisk> disks)
    {
        if (disks.Count == 0)
        {
            return new Dictionary<int, SmartInfo>();
        }

        IReadOnlyDictionary<int, ReliabilityCounters> reliability = ReadReliabilityCounters(disks);
        IReadOnlyDictionary<int, PredictStatus> predictStatus = ReadPredictStatus(disks);
        IReadOnlyDictionary<int, IReadOnlyList<SmartAttribute>> predictData = ReadPredictData(disks);

        var result = new Dictionary<int, SmartInfo>();

        foreach (PhysicalDisk disk in disks)
        {
            reliability.TryGetValue(disk.Index, out ReliabilityCounters? counters);
            predictStatus.TryGetValue(disk.Index, out PredictStatus? status);
            predictData.TryGetValue(disk.Index, out IReadOnlyList<SmartAttribute>? attributes);

            SmartInfo? info = Combine(disk, counters, status, attributes);

            if (info is not null)
            {
                result[disk.Index] = info;
            }
            else
            {
                _logger.LogInformation(
                    "No SMART source answered for physical drive {Index} ({Model}); its health is unknown.",
                    disk.Index,
                    disk.Model);
            }
        }

        return result;
    }

    /// <summary>
    /// Merges whatever the three sources produced into one reading.
    /// </summary>
    /// <remarks>
    /// The structured counters win wherever they answer, and
    /// <see cref="SmartInfo.Source"/> records which source the reading is
    /// mostly from, so a later trend query can tell a documented counter from a
    /// value decoded out of vendor bytes. Where a preferred source is silent on
    /// one attribute, a lesser source may still fill it — a drive that reports
    /// reliability counters but no temperature, and vendor bytes that carry
    /// one, should report the temperature it has.
    /// </remarks>
    private static SmartInfo? Combine(
        PhysicalDisk disk,
        ReliabilityCounters? counters,
        PredictStatus? status,
        IReadOnlyList<SmartAttribute>? attributes)
    {
        bool hasAttributes = attributes is { Count: > 0 };

        if (counters is null && status is null && !hasAttributes)
        {
            return null;
        }

        SmartSource source = counters is not null
            ? SmartSource.StorageReliabilityCounter
            : status is not null
                ? SmartSource.FailurePredictStatus
                : SmartSource.FailurePredictData;

        SmartInfo decoded = hasAttributes
            ? SmartAttributeDecoder.ToSmartInfo(attributes!, source)
            : new SmartInfo { Source = source };

        return decoded with
        {
            Source = source,

            // Reliability counters carry no reallocated/pending/uncorrectable
            // sector counts under those names, so the decoded ATA attributes
            // remain the only source for them.
            PowerOnHours = counters?.PowerOnHours ?? decoded.PowerOnHours,
            TemperatureCelsius = counters?.Temperature ?? decoded.TemperatureCelsius,
            TemperatureMax = counters?.TemperatureMax,
            Wear = counters?.Wear,
            ReadErrorsTotal = counters?.ReadErrorsTotal,
            ReadErrorsUncorrected = counters?.ReadErrorsUncorrected,
            WriteErrorsTotal = counters?.WriteErrorsTotal,
            WriteErrorsUncorrected = counters?.WriteErrorsUncorrected,
            StartStopCycleCount = counters?.StartStopCycleCount,

            OverallPredictFailure = status?.PredictFailure,
            PredictFailureReason = status?.Reason,

            SerialNumber = disk.SerialNumber,
            Model = disk.Model,
        };
    }

    /// <summary>
    /// Reads <c>MSFT_StorageReliabilityCounter</c>, correlated to physical
    /// drives through <c>MSFT_PhysicalDisk</c>.
    /// </summary>
    /// <remarks>
    /// The reliability counter is associated with a physical disk rather than
    /// carrying a drive number of its own, and <c>MSFT_PhysicalDisk.DeviceId</c>
    /// is the drive number as a string. Both are read and joined here rather
    /// than assumed to arrive in the same order.
    /// </remarks>
    private IReadOnlyDictionary<int, ReliabilityCounters> ReadReliabilityCounters(
        IReadOnlyList<PhysicalDisk> disks)
    {
        var result = new Dictionary<int, ReliabilityCounters>();

        try
        {
            IReadOnlyList<WmiRecord> rows = _wmi.Query(
                WmiScopes.Storage,
                "SELECT DeviceId, Wear, ReadErrorsTotal, ReadErrorsUncorrected, WriteErrorsTotal, " +
                "WriteErrorsUncorrected, PowerOnHours, Temperature, TemperatureMax, StartStopCycleCount " +
                "FROM MSFT_StorageReliabilityCounter");

            foreach (WmiRecord row in rows)
            {
                // DeviceId here is the physical drive number, as text.
                int? index = ParseDeviceId(row.GetString("DeviceId"));

                if (index is null || !disks.Any(d => d.Index == index))
                {
                    continue;
                }

                result[index.Value] = new ReliabilityCounters
                {
                    Wear = row.GetInt32("Wear"),
                    ReadErrorsTotal = row.GetInt64("ReadErrorsTotal"),
                    ReadErrorsUncorrected = row.GetInt64("ReadErrorsUncorrected"),
                    WriteErrorsTotal = row.GetInt64("WriteErrorsTotal"),
                    WriteErrorsUncorrected = row.GetInt64("WriteErrorsUncorrected"),
                    PowerOnHours = row.GetInt32("PowerOnHours"),
                    Temperature = Plausible(row.GetInt32("Temperature")),
                    TemperatureMax = Plausible(row.GetInt32("TemperatureMax")),
                    StartStopCycleCount = row.GetInt32("StartStopCycleCount"),
                };
            }
        }
        catch (Exception e)
        {
            // The storage namespace is absent on older builds, and the class is
            // not implemented by every driver. This is the preferred source,
            // not the only one.
            _logger.LogInformation(
                e, "MSFT_StorageReliabilityCounter is not available on this machine.");
        }

        return result;
    }

    private IReadOnlyDictionary<int, PredictStatus> ReadPredictStatus(IReadOnlyList<PhysicalDisk> disks)
    {
        var result = new Dictionary<int, PredictStatus>();

        try
        {
            foreach (WmiRecord row in _wmi.Query(
                         WmiScopes.Wmi,
                         "SELECT InstanceName, PredictFailure, Reason FROM MSStorageDriver_FailurePredictStatus"))
            {
                PhysicalDisk? disk = DiskTopology.MatchSmartInstance(row.GetString("InstanceName"), disks);

                if (disk is null)
                {
                    continue;
                }

                result[disk.Index] = new PredictStatus
                {
                    PredictFailure = row.GetBoolean("PredictFailure"),
                    Reason = row.GetInt32("Reason"),
                };
            }
        }
        catch (Exception e)
        {
            // Common on virtual machines, RAID controllers and USB bridges,
            // where the driver does not expose SMART at all.
            _logger.LogInformation(e, "SMART failure prediction is not available on this machine.");
        }

        return result;
    }

    private IReadOnlyDictionary<int, IReadOnlyList<SmartAttribute>> ReadPredictData(
        IReadOnlyList<PhysicalDisk> disks)
    {
        var result = new Dictionary<int, IReadOnlyList<SmartAttribute>>();

        try
        {
            foreach (WmiRecord row in _wmi.Query(
                         WmiScopes.Wmi,
                         "SELECT InstanceName, VendorSpecific FROM MSStorageDriver_FailurePredictData"))
            {
                PhysicalDisk? disk = DiskTopology.MatchSmartInstance(row.GetString("InstanceName"), disks);

                if (disk is null)
                {
                    continue;
                }

                IReadOnlyList<SmartAttribute> attributes =
                    SmartAttributeDecoder.Decode(row.GetBytes("VendorSpecific"));

                if (attributes.Count > 0)
                {
                    result[disk.Index] = attributes;
                }
            }
        }
        catch (Exception e)
        {
            _logger.LogInformation(e, "SMART attribute data is not available on this machine.");
        }

        return result;
    }

    private static int? ParseDeviceId(string? value) =>
        int.TryParse(value?.Trim(), out int index) ? index : null;

    /// <summary>
    /// A plausibility gate on a temperature.
    /// </summary>
    /// <remarks>
    /// A drive reporting 0 °C or 200 °C is a drive whose firmware fills the
    /// field with something else. Unknown beats wrong, and a null here is
    /// rendered as "not read" rather than as a cold drive.
    /// </remarks>
    private static int? Plausible(int? celsius) => celsius is > 0 and < 125 ? celsius : null;

    private sealed record ReliabilityCounters
    {
        public int? Wear { get; init; }

        public long? ReadErrorsTotal { get; init; }

        public long? ReadErrorsUncorrected { get; init; }

        public long? WriteErrorsTotal { get; init; }

        public long? WriteErrorsUncorrected { get; init; }

        public int? PowerOnHours { get; init; }

        public int? Temperature { get; init; }

        public int? TemperatureMax { get; init; }

        public int? StartStopCycleCount { get; init; }
    }

    private sealed record PredictStatus
    {
        public bool? PredictFailure { get; init; }

        public int? Reason { get; init; }
    }
}
