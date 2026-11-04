using System.Buffers.Binary;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>
/// storage.health without Windows: the request for an NVMe drive's health log (log page 02h) through IOCTL_STORAGE_QUERY_PROPERTY, the
/// reading of the drive's answer, the log itself, and the volume states Storage Management reports. The answer comes from drive firmware
/// and is treated as hostile: every offset and length is checked against what was returned, and an answer that does not hold a whole log is
/// said to be unreadable rather than read in part.
/// </summary>
public static class StorageHealth
{
    public const int MaxDrives = 32, MaxVolumes = 32;
    public const int LogBytes = 512;                       // NVME_MAX_LOG_SIZE: the health log is 512 bytes.
    private const int QueryHeader = 8;                     // STORAGE_PROPERTY_QUERY: PropertyId, QueryType, then AdditionalParameters.
    private const int SpecificData = 40;                   // STORAGE_PROTOCOL_SPECIFIC_DATA: ten ULONGs.
    private const int Descriptor = 8 + SpecificData;       // STORAGE_PROTOCOL_DATA_DESCRIPTOR: Version, Size, then the specific data.
    public const int QueryBytes = QueryHeader + SpecificData + LogBytes;

    private const uint StorageDeviceProtocolSpecificProperty = 50, PropertyStandardQuery = 0;
    private const uint ProtocolTypeNvme = 3, NvmeDataTypeLogPage = 2, HealthInfoLogPage = 0x02;

    /// <summary>The query buffer (also the answer buffer) asking the drive for its health log.</summary>
    public static byte[] NvmeHealthQuery()
    {
        var b = new byte[QueryBytes];
        var s = b.AsSpan();
        BinaryPrimitives.WriteUInt32LittleEndian(s[0..], StorageDeviceProtocolSpecificProperty);
        BinaryPrimitives.WriteUInt32LittleEndian(s[4..], PropertyStandardQuery);
        BinaryPrimitives.WriteUInt32LittleEndian(s[8..], ProtocolTypeNvme);
        BinaryPrimitives.WriteUInt32LittleEndian(s[12..], NvmeDataTypeLogPage);
        BinaryPrimitives.WriteUInt32LittleEndian(s[16..], HealthInfoLogPage);   // ProtocolDataRequestValue: the log page
        // ProtocolDataRequestSubValue (bytes 20..23) stays 0: it is the offset into the log, and the whole log is wanted.
        BinaryPrimitives.WriteUInt32LittleEndian(s[24..], SpecificData);        // ProtocolDataOffset: the log follows the specific data
        BinaryPrimitives.WriteUInt32LittleEndian(s[28..], LogBytes);            // ProtocolDataLength
        return b;
    }

    /// <summary>The health log from the drive's answer to <see cref="NvmeHealthQuery"/>, of which <paramref name="returned"/> bytes were written.</summary>
    public static (NvmeHealthInfo? Health, NvmeProblem? Problem) ReadNvmeAnswer(ReadOnlySpan<byte> answer, long returned)
    {
        if (returned < Descriptor || returned > answer.Length) return (null, NvmeProblem.Unreadable);
        var a = answer[..(int)returned];
        uint version = BinaryPrimitives.ReadUInt32LittleEndian(a[0..]), size = BinaryPrimitives.ReadUInt32LittleEndian(a[4..]);
        if (version != Descriptor || size != Descriptor) return (null, NvmeProblem.Unreadable);
        long offset = BinaryPrimitives.ReadUInt32LittleEndian(a[(8 + 16)..]), length = BinaryPrimitives.ReadUInt32LittleEndian(a[(8 + 20)..]);
        if (offset < SpecificData || length < LogBytes) return (null, NvmeProblem.Unreadable);
        long start = 8 + offset;
        if (start + LogBytes > a.Length) return (null, NvmeProblem.Unreadable);
        return ParseLog(a.Slice((int)start, LogBytes));
    }

    /// <summary>The SMART / Health Information log page (NVMe base specification, log page 02h).</summary>
    public static (NvmeHealthInfo? Health, NvmeProblem? Problem) ParseLog(ReadOnlySpan<byte> log)
    {
        if (log.Length < LogBytes) return (null, NvmeProblem.Unreadable);
        byte warn = log[0];
        int kelvin = BinaryPrimitives.ReadUInt16LittleEndian(log[1..]);
        int? celsius = kelvin == 0 ? null : kelvin - 273 is var c and >= -40 and <= 150 ? c : null; // 0: not reported
        return (new NvmeHealthInfo
        {
            CriticalWarnings = new NvmeCriticalWarnings
            {
                SpareBelowThreshold = (warn & 0x01) != 0,
                TemperatureOutOfRange = (warn & 0x02) != 0,
                ReliabilityDegraded = (warn & 0x04) != 0,
                ReadOnly = (warn & 0x08) != 0,
                VolatileBackupFailed = (warn & 0x10) != 0,
                PersistentMemoryReadOnly = (warn & 0x20) != 0,
            },
            TemperatureCelsius = celsius,
            AvailableSparePercent = log[3] <= 100 ? log[3] : null,
            SpareThresholdPercent = log[4] <= 100 ? log[4] : null,
            PercentageUsed = log[5],                                  // may pass 100 (to 255) once the rated endurance is used
            DataReadBytes = Bytes(Counter(log, 32)),                  // data units are thousands of 512-byte blocks
            DataWrittenBytes = Bytes(Counter(log, 48)),
            PowerCycles = Counter(log, 112),
            PowerOnHours = Counter(log, 128),
            UnsafeShutdowns = Counter(log, 144),
            MediaErrors = Counter(log, 160),
            ErrorLogEntries = Counter(log, 176),
            WarningTemperatureMinutes = BinaryPrimitives.ReadUInt32LittleEndian(log[192..]),
            CriticalTemperatureMinutes = BinaryPrimitives.ReadUInt32LittleEndian(log[196..]),
        }, null);
    }

    /// <summary>A 128-bit little-endian counter, held at the largest count the contract carries rather than wrapped.</summary>
    private static long Counter(ReadOnlySpan<byte> log, int at)
    {
        ulong low = BinaryPrimitives.ReadUInt64LittleEndian(log[at..]), high = BinaryPrimitives.ReadUInt64LittleEndian(log[(at + 8)..]);
        return high != 0 || low > MaxCount ? MaxCount : (long)low;
    }

    public const long MaxCount = 9_007_199_254_740_991; // the contract's count limit (2^53 - 1)
    private static long Bytes(long units) => units > MaxCount / 512_000 ? MaxCount : units * 512_000;

    /// <summary>MSFT_PhysicalDisk.BusType.</summary>
    public static StorageBus BusOf(long? busType) => busType switch
    {
        17 => StorageBus.Nvme, 11 => StorageBus.Sata, 10 => StorageBus.Sas, 7 => StorageBus.Usb, 8 => StorageBus.Raid,
        null or 0 => StorageBus.Unknown, _ => StorageBus.Other,
    };

    /// <summary>
    /// MSFT_Volume.HealthStatus, which for a volume is the file system's own repair state: Healthy (0), Scan Needed (1), Spot Fix
    /// Needed (2), Full Repair Needed (3) (Microsoft's MSFT_Volume class reference). Anything else is unknown, not guessed.
    /// </summary>
    public static VolumeRepair RepairOf(long? healthStatus) => healthStatus switch
    {
        0 => VolumeRepair.None, 1 => VolumeRepair.ScanNeeded, 2 => VolumeRepair.SpotFixNeeded, 3 => VolumeRepair.FullRepairNeeded,
        _ => VolumeRepair.Unknown,
    };

    public static VolumeFileSystem FileSystemOf(string? name) => name?.Trim().ToUpperInvariant() switch
    {
        null or "" => VolumeFileSystem.Unknown, "NTFS" => VolumeFileSystem.Ntfs, "REFS" => VolumeFileSystem.Refs, "FAT32" => VolumeFileSystem.Fat32,
        "EXFAT" => VolumeFileSystem.Exfat, "FAT" => VolumeFileSystem.Fat, _ => VolumeFileSystem.Other,
    };

    /// <summary>A drive letter as one upper-case letter, or null when the volume has none (or reported anything else).</summary>
    public static string? LetterOf(string? text) =>
        text is { Length: 1 } && char.ToUpperInvariant(text[0]) is var c and >= 'A' and <= 'Z' ? c.ToString() : null;

    public static long Count(long? value) => value is > 0 ? Math.Min(value.Value, MaxCount) : 0;
}
