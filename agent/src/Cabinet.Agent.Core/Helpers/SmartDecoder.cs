using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// Decodes the ATA SMART attribute table Windows exposes as
/// MSStorageDriver_FailurePredictData.VendorSpecific (2-byte header, then
/// 30 records of 12 bytes: id, flags(2), current, worst, raw(6), reserved).
/// </summary>
public static class SmartDecoder
{
    public const byte ReallocatedSectors = 5;
    public const byte PowerOnHours = 9;
    public const byte Temperature = 194;
    public const byte PendingSectors = 197;
    public const byte Uncorrectable = 198;

    public static IReadOnlyDictionary<byte, long> RawValues(byte[]? table)
    {
        var values = new Dictionary<byte, long>();
        if (table is null) return values;
        for (int i = 0; i < 30; i++)
        {
            int offset = 2 + i * 12;
            if (offset + 12 > table.Length) break;
            byte id = table[offset];
            if (id == 0 || values.ContainsKey(id)) continue;
            long raw = 0;
            for (int b = 0; b < 6; b++) raw |= (long)table[offset + 5 + b] << (8 * b);
            values[id] = raw;
        }
        return values;
    }

    /// <summary>Temperature is the low byte of the raw value; implausible readings are unknown rather than wrong.</summary>
    public static int? TemperatureCelsius(IReadOnlyDictionary<byte, long> raw) =>
        raw.TryGetValue(Temperature, out long t) && (t & 0xFF) is > 0 and < 125 ? (int)(t & 0xFF) : null;

    public static long? Value(IReadOnlyDictionary<byte, long> raw, byte id) => raw.TryGetValue(id, out long v) ? v : null;

    /// <summary>MSFT_PhysicalDisk.HealthStatus (0 healthy, 1 warning, 2 unhealthy) combined with the drive's own failure prediction.</summary>
    public static DriveHealth Health(int? healthStatus, bool? predictFailure, long? reallocated, long? pending) =>
        predictFailure == true || healthStatus == 2 ? DriveHealth.Failing
        : healthStatus == 1 || reallocated > 0 || pending > 0 ? DriveHealth.Warning
        : healthStatus == 0 ? DriveHealth.Healthy
        : DriveHealth.Unknown;
}
