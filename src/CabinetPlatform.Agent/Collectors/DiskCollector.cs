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
    private static readonly IReadOnlyDictionary<string, SmartInfo> EmptySmart =
        new Dictionary<string, SmartInfo>(StringComparer.OrdinalIgnoreCase);

    private readonly IWmiRepository _wmi;
    private readonly SmartReader _smart;
    private readonly ILogger<DiskCollector> _logger;

    private IReadOnlyDictionary<string, DiskHealthStatus> _lastKnownHealth =
        new Dictionary<string, DiskHealthStatus>(StringComparer.OrdinalIgnoreCase);

    /// <summary>Creates the collector.</summary>
    /// <param name="wmi">The agent's view of WMI.</param>
    /// <param name="smart">Reads SMART from the best source that answers.</param>
    /// <param name="logger">Diagnostic log.</param>
    public DiskCollector(IWmiRepository wmi, SmartReader smart, ILogger<DiskCollector> logger)
    {
        _wmi = wmi;
        _smart = smart;
        _logger = logger;
    }

    public string SectionName => CollectorSections.Disks;

    /// <inheritdoc />
    public bool RunsOnHeartbeat => true;

    /// <inheritdoc />
    public Task CollectAsync(CheckInDraft draft, CheckInTier tier, CancellationToken cancellationToken)
    {
        IReadOnlyList<VolumeReading> volumes = ReadVolumes();
        IReadOnlyDictionary<string, BitLockerStatus> bitLocker = ReadBitLockerStatuses();

        // SMART is read on the slow tier only. Interrogating every drive's
        // firmware every five minutes across seven thousand cabinets costs far
        // more than the readings change.
        IReadOnlyDictionary<string, SmartInfo> smartByDrive =
            tier == CheckInTier.Full ? ReadSmart().ByDriveLetter : EmptySmart;

        if (tier == CheckInTier.Full)
        {
            // Remember each volume's health so the heartbeats in between can
            // still report it without re-reading anything.
            var health = new Dictionary<string, DiskHealthStatus>(StringComparer.OrdinalIgnoreCase);

            foreach (VolumeReading volume in volumes)
            {
                smartByDrive.TryGetValue(volume.DriveLetter, out SmartInfo? smart);
                health[volume.DriveLetter] = DiskHealthEvaluator.Evaluate(smart);
            }

            _lastKnownHealth = health;
        }

        var disks = new List<DiskInfo>(volumes.Count);

        foreach (VolumeReading volume in volumes)
        {
            smartByDrive.TryGetValue(volume.DriveLetter, out SmartInfo? smart);

            // On a heartbeat the health is the last one actually measured, and
            // Unknown until something has been. A freshly restarted agent
            // reports "not known yet" rather than a clean bill of health it has
            // no basis for.
            DiskHealthStatus health = tier == CheckInTier.Full
                ? DiskHealthEvaluator.Evaluate(smart)
                : _lastKnownHealth.GetValueOrDefault(volume.DriveLetter, DiskHealthStatus.Unknown);

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
                BitLockerStatus = bitLocker.TryGetValue(volume.DriveLetter, out BitLockerStatus status)
                    ? status
                    : BitLockerStatus.Unknown,
                // Null on a heartbeat, so the server writes no SMART row for a
                // reading that was never taken.
                Smart = smart,
                HealthStatus = health,
            });
        }

        _logger.LogDebug("Collected {VolumeCount} volumes on the {Tier} tier.", disks.Count, tier);

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
    /// Reads SMART for every physical drive and attaches it to drive letters.
    /// </summary>
    /// <remarks>
    /// Correlation runs through the physical drive number throughout: from the
    /// SMART classes' instance names to <c>Win32_DiskDrive.Index</c>, and from
    /// there down the partition associations to a letter. Nothing is paired by
    /// the order rows arrive in, because the classes do not agree on one.
    /// </remarks>
    private (IReadOnlyDictionary<string, SmartInfo> ByDriveLetter, IReadOnlyList<PhysicalDisk> Disks) ReadSmart()
    {
        var byDriveLetter = new Dictionary<string, SmartInfo>(StringComparer.OrdinalIgnoreCase);

        IReadOnlyDictionary<string, PhysicalDisk> disksByLetter;
        IReadOnlyList<PhysicalDisk> physicalDisks;

        try
        {
            IReadOnlyList<WmiRecord> diskDrives = _wmi.Query(
                WmiScopes.CimV2,
                "SELECT DeviceID, Index, PNPDeviceID, Model, SerialNumber FROM Win32_DiskDrive");

            disksByLetter = DiskTopology.MapDriveLetters(
                diskDrives,
                _wmi.Query(WmiScopes.CimV2, "SELECT Antecedent, Dependent FROM Win32_DiskDriveToDiskPartition"),
                _wmi.Query(WmiScopes.CimV2, "SELECT Antecedent, Dependent FROM Win32_LogicalDiskToPartition"));

            physicalDisks = DiskTopology.ReadDisks(diskDrives);
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Disk topology was unreadable; SMART data cannot be attached to volumes.");
            return (byDriveLetter, Array.Empty<PhysicalDisk>());
        }

        IReadOnlyDictionary<int, SmartInfo> smartByDrive = _smart.Read(physicalDisks);

        foreach ((string letter, PhysicalDisk disk) in disksByLetter)
        {
            // A drive with no entry had nothing readable from any of the three
            // sources. It gets no SmartInfo at all, which is what makes its
            // health Unknown rather than Healthy.
            if (smartByDrive.TryGetValue(disk.Index, out SmartInfo? smart))
            {
                byDriveLetter[letter] = smart;
            }
        }

        return (byDriveLetter, physicalDisks);
    }
}
