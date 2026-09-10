using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Volumes, free space, BitLocker protection state and drive health.
/// </summary>
/// <remarks>
/// The three come from three different namespaces and are joined here.
/// Everything is best-effort per volume: a machine whose storage namespace is
/// missing still reports free space from <c>DriveInfo</c>, and a volume whose
/// SMART data is unreadable is reported with a null <see cref="DiskInfo.Smart"/>
/// and <see cref="DiskHealthStatus.Unknown"/> rather than a fabricated clean
/// bill of health.
/// </remarks>
public sealed class DiskCollector : ICollector
{
    private readonly IWmiRepository _wmi;
    private readonly ILogger<DiskCollector> _logger;

    public DiskCollector(IWmiRepository wmi, ILogger<DiskCollector> logger)
    {
        _wmi = wmi;
        _logger = logger;
    }

    public string SectionName => CollectorSections.Disks;

    public Task CollectAsync(CheckInDraft draft, CancellationToken cancellationToken)
    {
        var volumes = ReadVolumes();
        var bitLocker = ReadBitLockerStatuses();
        var (smartByDrive, physicalDisks) = ReadSmart();

        var disks = new List<DiskInfo>(volumes.Count);

        foreach (var volume in volumes)
        {
            smartByDrive.TryGetValue(volume.DriveLetter, out var smart);
            var health = DiskHealthEvaluator.Evaluate(smart);

            disks.Add(new DiskInfo
            {
                DriveLetter = volume.DriveLetter,
                Label = volume.Label,
                FileSystem = volume.FileSystem,
                TotalBytes = volume.TotalBytes,
                FreeBytes = volume.FreeBytes,
                FreePercent = volume.TotalBytes is > 0 && volume.FreeBytes is not null
                    ? Math.Round(volume.FreeBytes.Value / (double)volume.TotalBytes.Value * 100.0, 2)
                    : null,
                BitLockerStatus = bitLocker.TryGetValue(volume.DriveLetter, out var status)
                    ? status
                    : BitLockerStatus.Unknown,
                Smart = smart,
                HealthStatus = health,
            });
        }

        _logger.LogDebug(
            "Collected {VolumeCount} volumes across {DiskCount} physical disks.",
            disks.Count,
            physicalDisks.Count);

        draft.Disks = disks
            .OrderBy(disk => disk.DriveLetter, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return Task.CompletedTask;
    }

    private sealed record VolumeReading(
        string DriveLetter,
        string? Label,
        string? FileSystem,
        long? TotalBytes,
        long? FreeBytes);

    private IReadOnlyList<VolumeReading> ReadVolumes()
    {
        try
        {
            var rows = _wmi.Query(
                WmiScopes.Storage,
                "SELECT DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining FROM MSFT_Volume");

            var volumes = rows
                .Select(row => new
                {
                    Letter = DiskTopology.NormaliseDriveLetter(row.GetString("DriveLetter")),
                    Row = row,
                })
                // Volumes without a letter (recovery, EFI system partitions) are
                // not something support can act on and only add noise.
                .Where(entry => entry.Letter.Length > 0)
                .Select(entry => new VolumeReading(
                    entry.Letter,
                    entry.Row.GetString("FileSystemLabel"),
                    entry.Row.GetString("FileSystem"),
                    entry.Row.GetInt64("Size"),
                    entry.Row.GetInt64("SizeRemaining")))
                .ToArray();

            if (volumes.Length > 0)
            {
                return volumes;
            }

            _logger.LogDebug("MSFT_Volume returned no lettered volumes; falling back to DriveInfo.");
        }
        catch (Exception e)
        {
            // The storage namespace is absent on older builds. Basic free space
            // is still worth having, so this degrades rather than fails.
            _logger.LogWarning(e, "MSFT_Volume was unavailable; falling back to DriveInfo.");
        }

        return ReadVolumesFromDriveInfo();
    }

    private IReadOnlyList<VolumeReading> ReadVolumesFromDriveInfo()
    {
        var volumes = new List<VolumeReading>();

        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady || drive.DriveType != DriveType.Fixed)
                {
                    continue;
                }

                volumes.Add(new VolumeReading(
                    DiskTopology.NormaliseDriveLetter(drive.Name),
                    string.IsNullOrWhiteSpace(drive.VolumeLabel) ? null : drive.VolumeLabel,
                    drive.DriveFormat,
                    drive.TotalSize,
                    drive.TotalFreeSpace));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _logger.LogDebug(e, "Drive {DriveName} could not be read.", drive.Name);
            }
        }

        return volumes;
    }

    /// <summary>
    /// Reads BitLocker protection state per volume.
    /// </summary>
    /// <remarks>
    /// Protection status alone cannot tell an encrypted volume from one that is
    /// still encrypting, and cannot see a locked volume at all. Conversion and
    /// lock state are only available as method calls, so all three are combined.
    /// On a DEA-audited cabinet, "encrypted" and "encrypting" are materially
    /// different answers.
    /// </remarks>
    private IReadOnlyDictionary<string, BitLockerStatus> ReadBitLockerStatuses()
    {
        var statuses = new Dictionary<string, BitLockerStatus>(StringComparer.OrdinalIgnoreCase);

        IReadOnlyList<WmiRecord> rows;
        try
        {
            rows = _wmi.Query(
                WmiScopes.VolumeEncryption,
                "SELECT DeviceID, DriveLetter, ProtectionStatus FROM Win32_EncryptableVolume");
        }
        catch (Exception e)
        {
            // The namespace is absent on editions without BitLocker. Every
            // volume then reports Unknown, which is accurate.
            _logger.LogWarning(e, "BitLocker namespace was unavailable; protection state is unknown.");
            return statuses;
        }

        foreach (var row in rows)
        {
            var letter = DiskTopology.NormaliseDriveLetter(row.GetString("DriveLetter"));
            if (letter.Length == 0)
            {
                continue;
            }

            var deviceId = row.GetString("DeviceID");
            var protectionStatus = row.GetInt32("ProtectionStatus");

            statuses[letter] = DeriveBitLockerStatus(
                protectionStatus,
                ReadConversionStatus(deviceId),
                ReadLockStatus(deviceId));
        }

        return statuses;
    }

    private int? ReadConversionStatus(string? deviceId)
        => InvokeVolumeMethod(deviceId, "GetConversionStatus", "ConversionStatus");

    private int? ReadLockStatus(string? deviceId)
        => InvokeVolumeMethod(deviceId, "GetLockStatus", "LockStatus");

    private int? InvokeVolumeMethod(string? deviceId, string methodName, string outputName)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            return null;
        }

        try
        {
            var escaped = deviceId.Replace("\\", "\\\\", StringComparison.Ordinal);
            var results = _wmi.InvokeMethod(
                WmiScopes.VolumeEncryption,
                $"SELECT * FROM Win32_EncryptableVolume WHERE DeviceID = '{escaped}'",
                methodName);

            var result = results.FirstOrDefault();
            return result is { Succeeded: true } ? result.Output?.GetInt32(outputName) : null;
        }
        catch (Exception e)
        {
            _logger.LogDebug(e, "BitLocker {Method} failed for {DeviceId}.", methodName, deviceId);
            return null;
        }
    }

    /// <summary>
    /// Combines protection, conversion and lock state into one status.
    /// </summary>
    internal static BitLockerStatus DeriveBitLockerStatus(
        int? protectionStatus,
        int? conversionStatus,
        int? lockStatus)
    {
        // A locked volume is encrypted and unavailable. It is the state a
        // cabinet sits in when it fails to unseal at boot, so it outranks the
        // rest: support needs to see it immediately.
        if (lockStatus == 1)
        {
            return BitLockerStatus.EncryptedLocked;
        }

        switch (conversionStatus)
        {
            case 2:
                return BitLockerStatus.EncryptionInProgress;
            case 3:
                return BitLockerStatus.DecryptionInProgress;
            case 0:
                return BitLockerStatus.NotEncrypted;
        }

        return protectionStatus switch
        {
            // Protection off on a fully encrypted volume means the key
            // protectors are suspended, not that the data is in the clear.
            0 when conversionStatus == 1 => BitLockerStatus.Suspended,
            0 => BitLockerStatus.NotEncrypted,
            1 => BitLockerStatus.EncryptedUnlocked,
            _ => BitLockerStatus.Unknown,
        };
    }

    /// <summary>
    /// Reads SMART status and attribute data and attaches it to drive letters.
    /// </summary>
    private (IReadOnlyDictionary<string, SmartInfo> ByDriveLetter, IReadOnlyList<PhysicalDisk> Disks) ReadSmart()
    {
        var byDriveLetter = new Dictionary<string, SmartInfo>(StringComparer.OrdinalIgnoreCase);

        IReadOnlyDictionary<string, PhysicalDisk> disksByLetter;
        List<PhysicalDisk> physicalDisks;

        try
        {
            var diskDrives = _wmi.Query(
                WmiScopes.CimV2,
                "SELECT DeviceID, PNPDeviceID, Model, SerialNumber FROM Win32_DiskDrive");

            disksByLetter = DiskTopology.MapDriveLetters(
                diskDrives,
                _wmi.Query(WmiScopes.CimV2, "SELECT Antecedent, Dependent FROM Win32_DiskDriveToDiskPartition"),
                _wmi.Query(WmiScopes.CimV2, "SELECT Antecedent, Dependent FROM Win32_LogicalDiskToPartition"));

            physicalDisks = diskDrives
                .Select(row => new PhysicalDisk
                {
                    DeviceId = row.GetString("DeviceID") ?? string.Empty,
                    PnpDeviceId = row.GetString("PNPDeviceID"),
                    Model = row.GetString("Model"),
                    SerialNumber = row.GetString("SerialNumber"),
                })
                .Where(disk => disk.DeviceId.Length > 0)
                .ToList();
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Disk topology was unreadable; SMART data cannot be attached to volumes.");
            return (byDriveLetter, Array.Empty<PhysicalDisk>());
        }

        var predictFailureByDisk = ReadPredictFailure(physicalDisks);
        var attributesByDisk = ReadPredictData(physicalDisks);

        foreach (var (letter, disk) in disksByLetter)
        {
            predictFailureByDisk.TryGetValue(disk.DeviceId, out var predictFailure);
            attributesByDisk.TryGetValue(disk.DeviceId, out var attributes);

            // Nothing was readable for this drive. A null SmartInfo is what
            // makes the health status Unknown rather than Healthy.
            if (predictFailure is null && attributes is null)
            {
                continue;
            }

            byDriveLetter[letter] = SmartAttributeDecoder.ToSmartInfo(
                attributes ?? Array.Empty<SmartAttribute>(),
                predictFailure,
                disk.Model,
                disk.SerialNumber);
        }

        return (byDriveLetter, physicalDisks);
    }

    private Dictionary<string, bool?> ReadPredictFailure(IReadOnlyList<PhysicalDisk> disks)
    {
        var result = new Dictionary<string, bool?>(StringComparer.OrdinalIgnoreCase);

        try
        {
            foreach (var row in _wmi.Query(
                         WmiScopes.Wmi,
                         "SELECT InstanceName, PredictFailure FROM MSStorageDriver_FailurePredictStatus"))
            {
                var disk = DiskTopology.MatchSmartInstance(row.GetString("InstanceName"), disks);
                if (disk is not null)
                {
                    result[disk.DeviceId] = row.GetBoolean("PredictFailure");
                }
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

    private Dictionary<string, IReadOnlyList<SmartAttribute>> ReadPredictData(IReadOnlyList<PhysicalDisk> disks)
    {
        var result = new Dictionary<string, IReadOnlyList<SmartAttribute>>(StringComparer.OrdinalIgnoreCase);

        try
        {
            foreach (var row in _wmi.Query(
                         WmiScopes.Wmi,
                         "SELECT InstanceName, VendorSpecific FROM MSStorageDriver_FailurePredictData"))
            {
                var disk = DiskTopology.MatchSmartInstance(row.GetString("InstanceName"), disks);
                if (disk is null)
                {
                    continue;
                }

                var attributes = SmartAttributeDecoder.Decode(row.GetBytes("VendorSpecific"));
                if (attributes.Count > 0)
                {
                    result[disk.DeviceId] = attributes;
                }
            }
        }
        catch (Exception e)
        {
            _logger.LogInformation(e, "SMART attribute data is not available on this machine.");
        }

        return result;
    }
}
