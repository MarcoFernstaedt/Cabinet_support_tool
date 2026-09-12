using System.Globalization;
using CabinetPlatform.Agent.Platform.Wmi;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>A physical drive as Win32_DiskDrive describes it.</summary>
public sealed record PhysicalDisk
{
    /// <summary>The <c>\\.\PHYSICALDRIVE<em>n</em></c> device path.</summary>
    public required string DeviceId { get; init; }

    /// <summary>
    /// The drive's physical drive number, from <c>Win32_DiskDrive.Index</c>.
    /// </summary>
    /// <remarks>
    /// This is the correlation key for everything else about the drive. Both
    /// SMART classes name their instance by this number, and the storage
    /// namespace keys on it too, so it is the one identifier every source
    /// agrees on.
    /// </remarks>
    public required int Index { get; init; }

    /// <summary>The PnP path.</summary>
    public string? PnpDeviceId { get; init; }

    /// <summary>Drive model string.</summary>
    public string? Model { get; init; }

    /// <summary>Drive serial number.</summary>
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
    /// <param name="diskDrives">Rows from <c>Win32_DiskDrive</c>.</param>
    /// <param name="diskDriveToPartition">Rows from <c>Win32_DiskDriveToDiskPartition</c>.</param>
    /// <param name="logicalDiskToPartition">Rows from <c>Win32_LogicalDiskToPartition</c>.</param>
    /// <returns>Keys are normalised drive letters such as <c>C</c>.</returns>
    public static IReadOnlyDictionary<string, PhysicalDisk> MapDriveLetters(
        IReadOnlyList<WmiRecord> diskDrives,
        IReadOnlyList<WmiRecord> diskDriveToPartition,
        IReadOnlyList<WmiRecord> logicalDiskToPartition)
    {
        var disksByDeviceId = new Dictionary<string, PhysicalDisk>(StringComparer.OrdinalIgnoreCase);

        foreach (PhysicalDisk disk in ReadDisks(diskDrives))
        {
            disksByDeviceId[disk.DeviceId] = disk;
        }

        // Partition device id -> physical disk.
        var diskByPartition = new Dictionary<string, PhysicalDisk>(StringComparer.OrdinalIgnoreCase);
        foreach (WmiRecord row in diskDriveToPartition)
        {
            string? diskDeviceId = WmiReference.GetKeyValue(row.GetString("Antecedent"), "DeviceID");
            string? partitionId = WmiReference.GetKeyValue(row.GetString("Dependent"), "DeviceID");

            if (diskDeviceId is null || partitionId is null)
            {
                continue;
            }

            if (disksByDeviceId.TryGetValue(diskDeviceId, out PhysicalDisk? disk))
            {
                diskByPartition[partitionId] = disk;
            }
        }

        // Drive letter -> partition -> physical disk.
        var diskByDriveLetter = new Dictionary<string, PhysicalDisk>(StringComparer.OrdinalIgnoreCase);
        foreach (WmiRecord row in logicalDiskToPartition)
        {
            string? partitionId = WmiReference.GetKeyValue(row.GetString("Antecedent"), "DeviceID");
            string? logicalDiskId = WmiReference.GetKeyValue(row.GetString("Dependent"), "DeviceID");

            if (partitionId is null || logicalDiskId is null)
            {
                continue;
            }

            if (diskByPartition.TryGetValue(partitionId, out PhysicalDisk? disk))
            {
                diskByDriveLetter[NormaliseDriveLetter(logicalDiskId)] = disk;
            }
        }

        return diskByDriveLetter;
    }

    /// <summary>
    /// Materialises the physical drives, keeping only those that report an
    /// index.
    /// </summary>
    /// <remarks>
    /// A drive with no index cannot be correlated to any SMART source, so it is
    /// better dropped than carried forward to be matched by position later.
    /// </remarks>
    /// <param name="diskDrives">Rows from <c>Win32_DiskDrive</c>.</param>
    public static IReadOnlyList<PhysicalDisk> ReadDisks(IReadOnlyList<WmiRecord> diskDrives)
    {
        var disks = new List<PhysicalDisk>(diskDrives.Count);

        foreach (WmiRecord row in diskDrives)
        {
            string? deviceId = row.GetString("DeviceID");
            int? index = row.GetInt32("Index");

            if (deviceId is null || index is null)
            {
                continue;
            }

            disks.Add(new PhysicalDisk
            {
                DeviceId = deviceId,
                Index = index.Value,
                PnpDeviceId = row.GetString("PNPDeviceID"),
                Model = row.GetString("Model"),
                SerialNumber = Clean(row.GetString("SerialNumber")),
            });
        }

        return disks;
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
    /// <param name="value">The raw value.</param>
    public static string NormaliseDriveLetter(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        string trimmed = value.Trim().TrimEnd('\\').TrimEnd(':');
        return trimmed.Length == 0 ? string.Empty : trimmed.ToUpperInvariant();
    }

    /// <summary>
    /// Reads the physical drive number out of a SMART class's
    /// <c>InstanceName</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The WMI storage driver classes name each instance by appending the
    /// physical drive number to the device's PnP path, as
    /// <c>SCSI\Disk&amp;Ven_...\4&amp;2d33d0c9&amp;0&amp;000000_0</c>. The
    /// trailing <c>_0</c> is drive 0 — it is not a decorative suffix, and it is
    /// the only part of the string that reliably identifies which drive the row
    /// describes.
    /// </para>
    /// <para>
    /// This is the correlation that matters.
    /// <c>Win32_DiskDrive</c> and <c>MSStorageDriver_FailurePredictData</c> do
    /// not return their rows in a guaranteed order, and they do not
    /// necessarily return the same number of rows, so pairing them by position
    /// attributes one drive's SMART data to another. On a cabinet with a
    /// healthy system disk and a failing data disk, that is the difference
    /// between replacing the right drive and replacing the wrong one.
    /// </para>
    /// </remarks>
    /// <param name="instanceName">The instance name from the SMART class.</param>
    /// <returns>The drive number, or null when the name does not carry one.</returns>
    public static int? ParsePhysicalDriveNumber(string? instanceName)
    {
        if (string.IsNullOrWhiteSpace(instanceName))
        {
            return null;
        }

        string text = instanceName.Trim();
        int separator = text.LastIndexOf('_');

        if (separator < 0 || separator == text.Length - 1)
        {
            return null;
        }

        ReadOnlySpan<char> tail = text.AsSpan(separator + 1);

        foreach (char c in tail)
        {
            if (!char.IsDigit(c))
            {
                return null;
            }
        }

        return int.TryParse(tail, NumberStyles.None, CultureInfo.InvariantCulture, out int number)
            ? number
            : null;
    }

    /// <summary>
    /// Matches a SMART instance name to a physical disk by drive number.
    /// </summary>
    /// <param name="instanceName">The instance name from the SMART class.</param>
    /// <param name="disks">The physical disks, as Win32_DiskDrive described them.</param>
    /// <returns>The disk, or null when the name names a drive that is not present.</returns>
    public static PhysicalDisk? MatchSmartInstance(
        string? instanceName, IReadOnlyCollection<PhysicalDisk> disks)
    {
        int? driveNumber = ParsePhysicalDriveNumber(instanceName);

        if (driveNumber is null)
        {
            return null;
        }

        foreach (PhysicalDisk disk in disks)
        {
            if (disk.Index == driveNumber)
            {
                return disk;
            }
        }

        // A row naming a drive this machine does not report is dropped rather
        // than attached to whatever happened to be nearby.
        return null;
    }

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
