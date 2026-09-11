using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// Where a drive's SMART counters were read from.
/// </summary>
/// <remarks>
/// <para>
/// The three sources are not interchangeable, so a reading records which one it
/// came from. A trend query that mixes a structured
/// <see cref="StorageReliabilityCounter"/> reading with a value decoded out of
/// a vendor-specific byte array is comparing two different measurements that
/// happen to share a name.
/// </para>
/// <para>
/// <see cref="Unavailable"/> is never written alongside counters. It exists so
/// that "we looked and there was nothing to read" is a statement the system can
/// make, distinct from never having looked.
/// </para>
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SmartSource
{
    /// <summary>No source produced a reading for this drive.</summary>
    Unavailable = 0,

    /// <summary>
    /// <c>MSFT_StorageReliabilityCounter</c> in
    /// <c>root\Microsoft\Windows\Storage</c>. Documented, structured, and
    /// preferred.
    /// </summary>
    StorageReliabilityCounter = 1,

    /// <summary>
    /// <c>MSStorageDriver_FailurePredictStatus</c> in <c>root\wmi</c>. Carries
    /// the drive's own verdict and a reason code, but no counters.
    /// </summary>
    FailurePredictStatus = 2,

    /// <summary>
    /// <c>MSStorageDriver_FailurePredictData</c> in <c>root\wmi</c>, decoded
    /// from the vendor-specific byte array. The last resort: the layout is
    /// vendor specific, and the class is absent on USB-attached drives, on many
    /// virtual machines, and wherever the vendor driver does not expose it.
    /// </summary>
    FailurePredictData = 3,
}

/// <summary>
/// SMART attributes read from a physical drive.
/// </summary>
/// <remarks>
/// Every counter is nullable because not every drive, controller or driver
/// exposes every attribute, and because the three sources expose different
/// sets. An attribute that was not reported is <see langword="null"/>.
/// Recording zero for an unreported counter would look like a pristine drive
/// and would poison any trend built from it, so it is treated as a correctness
/// bug rather than a convenience.
/// </remarks>
public sealed record SmartInfo
{
    /// <summary>Which WMI source these counters came from.</summary>
    public required SmartSource Source { get; init; }

    /// <summary>Count of sectors reallocated after a read or write failure.</summary>
    public int? ReallocatedSectorCount { get; init; }

    /// <summary>Count of unstable sectors awaiting reallocation.</summary>
    public int? PendingSectorCount { get; init; }

    /// <summary>Count of errors the drive could not correct.</summary>
    public int? UncorrectableErrorCount { get; init; }

    /// <summary>Cumulative powered-on hours.</summary>
    public int? PowerOnHours { get; init; }

    /// <summary>Current drive temperature, in degrees Celsius.</summary>
    public int? TemperatureCelsius { get; init; }

    /// <summary>The drive's own failure prediction flag, or <see langword="null"/> if it does not report one.</summary>
    public bool? OverallPredictFailure { get; init; }

    /// <summary>
    /// Vendor reason code accompanying <see cref="OverallPredictFailure"/>,
    /// from <c>MSStorageDriver_FailurePredictStatus</c>. Its meaning is vendor
    /// specific; it is carried for a support engineer to read, not interpreted.
    /// </summary>
    public int? PredictFailureReason { get; init; }

    /// <summary>
    /// Percentage of the drive's rated write endurance consumed, from
    /// <c>MSFT_StorageReliabilityCounter</c>. Solid-state drives report it;
    /// spinning drives do not.
    /// </summary>
    public int? Wear { get; init; }

    /// <summary>Total read errors the drive has seen, corrected ones included.</summary>
    public long? ReadErrorsTotal { get; init; }

    /// <summary>Read errors the drive could not correct.</summary>
    public long? ReadErrorsUncorrected { get; init; }

    /// <summary>Total write errors the drive has seen, corrected ones included.</summary>
    public long? WriteErrorsTotal { get; init; }

    /// <summary>Write errors the drive could not correct.</summary>
    public long? WriteErrorsUncorrected { get; init; }

    /// <summary>Highest temperature the drive has recorded, in degrees Celsius.</summary>
    public int? TemperatureMax { get; init; }

    /// <summary>Number of start-stop cycles the drive has completed.</summary>
    public int? StartStopCycleCount { get; init; }

    /// <summary>Drive serial number, used to follow a physical drive across re-imaging.</summary>
    public string? SerialNumber { get; init; }

    /// <summary>Drive model string.</summary>
    public string? Model { get; init; }
}
