using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// A fixed disk or volume, its capacity, throughput and health.
/// </summary>
public sealed record DiskInfo
{
    /// <summary>Drive letter including colon, for example "C:".</summary>
    public string? DriveLetter { get; init; }

    /// <summary>Volume label.</summary>
    public string? Label { get; init; }

    /// <summary>File system name, for example "NTFS".</summary>
    public string? FileSystem { get; init; }

    /// <summary>Total capacity, in bytes.</summary>
    public long? TotalBytes { get; init; }

    /// <summary>Free space, in bytes.</summary>
    public long? FreeBytes { get; init; }

    /// <summary>Free space as a percentage from 0 to 100.</summary>
    public double? FreePercent { get; init; }

    /// <summary>BitLocker protection state of the volume.</summary>
    public required BitLockerStatus BitLockerStatus { get; init; }

    /// <summary>Average outstanding I/O requests at sample time.</summary>
    public double? QueueDepth { get; init; }

    /// <summary>Read throughput at sample time, in bytes per second.</summary>
    public double? ReadBytesPerSec { get; init; }

    /// <summary>Write throughput at sample time, in bytes per second.</summary>
    public double? WriteBytesPerSec { get; init; }

    /// <summary>
    /// SMART attributes for the underlying physical drive, or
    /// <see langword="null"/> when the drive or its controller exposes none.
    /// </summary>
    public SmartInfo? Smart { get; init; }

    /// <summary>Overall health assessment for the drive.</summary>
    public required DiskHealthStatus HealthStatus { get; init; }
}

/// <summary>
/// BitLocker protection state of a volume.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BitLockerStatus
{
    /// <summary>Protection state could not be determined.</summary>
    Unknown = 0,

    /// <summary>The volume is not encrypted.</summary>
    NotEncrypted = 1,

    /// <summary>Encryption is in progress.</summary>
    EncryptionInProgress = 2,

    /// <summary>Decryption is in progress.</summary>
    DecryptionInProgress = 3,

    /// <summary>The volume is encrypted and unlocked.</summary>
    EncryptedUnlocked = 4,

    /// <summary>The volume is encrypted and locked.</summary>
    EncryptedLocked = 5,

    /// <summary>The volume is encrypted but protection is suspended.</summary>
    Suspended = 6,
}

/// <summary>
/// Overall health assessment for a drive.
/// </summary>
/// <remarks>
/// <see cref="Unknown"/> is deliberately the zero value: an uninitialised or
/// missing health status must never read as <see cref="Healthy"/>.
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DiskHealthStatus
{
    /// <summary>Health could not be assessed.</summary>
    Unknown = 0,

    /// <summary>No indicators of trouble.</summary>
    Healthy = 1,

    /// <summary>Indicators warrant monitoring but no action yet.</summary>
    Watch = 2,

    /// <summary>The drive is failing or predicted to fail.</summary>
    Failing = 3,
}
