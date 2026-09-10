namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// SMART attributes read from a physical drive.
/// </summary>
/// <remarks>
/// Every counter is nullable because not every drive, controller or driver
/// exposes every attribute. An attribute that was not reported is
/// <see langword="null"/>. Recording zero for an unreported counter would
/// look like a pristine drive and would poison any trend built from it, so it
/// is treated as a correctness bug rather than a convenience.
/// </remarks>
public sealed record SmartInfo
{
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

    /// <summary>Drive serial number, used to follow a physical drive across re-imaging.</summary>
    public string? SerialNumber { get; init; }

    /// <summary>Drive model string.</summary>
    public string? Model { get; init; }
}
