using CabinetPlatform.Agent.Platform.Wmi;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>A physical drive as Win32_DiskDrive describes it.</summary>
public sealed record PhysicalDisk
{
    public required string DeviceId { get; init; }

    /// <summary>The PnP path, which is what SMART instance names are built from.</summary>
    public string? PnpDeviceId { get; init; }

    public string? Model { get; init; }

    public string? SerialNumber { get; init; }
}

/// <summary>
/// Joins drive letters to the physical disks underneath them, and physical
/// disks to their SMART instances.
/// </summary>
/// <remarks>
/// SMART is reported per physical drive while free space and BitLocker are
/// reported per volume, so attaching a failing disk's health to the right drive
/// letter takes two association hops:
/// <c>Win32_DiskDrive -&gt; Win32_DiskPartition -&gt; Win32_LogicalDisk</c>.
/// Guessing the mapping instead would, on any cabinet with two drives, put one
/// disk's SMART data against the other's letters.
/// </remarks>
public static class DiskTopology
{
    /// <summary>
    /// Builds a drive-letter to physical-disk map from the disk drive rows and
    /// the two association classes.
    /// </summary>
    /// <returns>Keys are normalised drive letters such as <c>C</c>.</returns>
    public static IReadOnlyDictionary<string, PhysicalDisk> MapDriveLetters(
        IReadOnlyList<WmiRecord> diskDrives,
        IReadOnlyList<WmiRecord> diskDriveToPartition,
        IReadOnlyList<WmiRecord> logicalDiskToPartition)
    {
        var disksByDeviceId = new Dictionary<string, PhysicalDisk>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in diskDrives)
        {
            var deviceId = row.GetString("DeviceID");
            if (deviceId is null)
            {
                continue;
            }

            disksByDeviceId[deviceId] = new PhysicalDisk
            {
                DeviceId = deviceId,
                PnpDeviceId = row.GetString("PNPDeviceID"),
                Model = row.GetString("Model"),
                SerialNumber = row.GetString("SerialNumber"),
            };
        }

        // Partition device id -> physical disk.
        var diskByPartition = new Dictionary<string, PhysicalDisk>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in diskDriveToPartition)
        {
            var diskDeviceId = WmiReference.GetKeyValue(row.GetString("Antecedent"), "DeviceID");
            var partitionId = WmiReference.GetKeyValue(row.GetString("Dependent"), "DeviceID");

            if (diskDeviceId is null || partitionId is null)
            {
                continue;
            }

            if (disksByDeviceId.TryGetValue(diskDeviceId, out var disk))
            {
                diskByPartition[partitionId] = disk;
            }
        }

        // Drive letter -> partition -> physical disk.
        var diskByDriveLetter = new Dictionary<string, PhysicalDisk>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in logicalDiskToPartition)
        {
            var partitionId = WmiReference.GetKeyValue(row.GetString("Antecedent"), "DeviceID");
            var logicalDiskId = WmiReference.GetKeyValue(row.GetString("Dependent"), "DeviceID");

            if (partitionId is null || logicalDiskId is null)
            {
                continue;
            }

            if (diskByPartition.TryGetValue(partitionId, out var disk))
            {
                diskByDriveLetter[NormaliseDriveLetter(logicalDiskId)] = disk;
            }
        }

        return diskByDriveLetter;
    }

    /// <summary>
    /// Reduces the several shapes a drive letter arrives in to a bare letter.
    /// </summary>
    /// <remarks>
    /// <c>Win32_LogicalDisk</c> says <c>C:</c>, <c>MSFT_Volume</c> says
    /// <c>C</c>, and <c>Win32_EncryptableVolume</c> says <c>C:</c> as well.
    /// Comparing those unnormalised means BitLocker status quietly never
    /// matches a volume.
    /// </remarks>
    public static string NormaliseDriveLetter(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var trimmed = value.Trim().TrimEnd('\\').TrimEnd(':');
        return trimmed.Length == 0 ? string.Empty : trimmed.ToUpperInvariant();
    }

    /// <summary>
    /// Matches a SMART instance name to a physical disk's PnP device id.
    /// </summary>
    /// <remarks>
    /// The two are the same path in different dress: the SMART class appends an
    /// instance ordinal such as <c>_0</c> and the two classes disagree about
    /// case. Comparing them as-is never matches, which presents as a fleet
    /// where no drive has readable SMART data.
    /// </remarks>
    public static PhysicalDisk? MatchSmartInstance(
        string? instanceName,
        IReadOnlyCollection<PhysicalDisk> disks)
    {
        var normalisedInstance = NormaliseDeviceIdentity(instanceName);
        if (normalisedInstance.Length == 0)
        {
            return null;
        }

        foreach (var disk in disks)
        {
            var normalisedPnp = NormaliseDeviceIdentity(disk.PnpDeviceId);
            if (normalisedPnp.Length == 0)
            {
                continue;
            }

            if (normalisedInstance.Equals(normalisedPnp, StringComparison.Ordinal) ||
                normalisedInstance.StartsWith(normalisedPnp, StringComparison.Ordinal) ||
                normalisedPnp.StartsWith(normalisedInstance, StringComparison.Ordinal))
            {
                return disk;
            }
        }

        return null;
    }

    private static string NormaliseDeviceIdentity(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var text = value.Trim().ToUpperInvariant();

        // Strip the trailing instance ordinal the SMART classes append.
        var lastUnderscore = text.LastIndexOf('_');
        if (lastUnderscore > 0 && lastUnderscore == text.Length - 2 && char.IsDigit(text[^1]))
        {
            text = text[..lastUnderscore];
        }

        return text;
    }
}
