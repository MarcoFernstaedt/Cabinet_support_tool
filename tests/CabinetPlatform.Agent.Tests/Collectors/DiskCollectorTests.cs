using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Collectors;

public class DiskTopologyTests
{
    [Theory]
    [InlineData("C:", "C")]
    [InlineData("C", "C")]
    [InlineData("c:\\", "C")]
    [InlineData(" D: ", "D")]
    [InlineData(null, "")]
    [InlineData("", "")]
    public void NormaliseDriveLetter_ReducesEveryShapeToABareLetter(string? input, string expected)
    {
        // MSFT_Volume, Win32_LogicalDisk and Win32_EncryptableVolume each spell
        // a drive letter differently. Unnormalised, BitLocker status never
        // matches a volume and every disk silently reports Unknown.
        Assert.Equal(expected, DiskTopology.NormaliseDriveLetter(input));
    }

    [Fact]
    public void MapDriveLetters_JoinsVolumesToThePhysicalDiskUnderThem()
    {
        var diskDrives = new[]
        {
            FakeWmiRepository.Row(
                ("DeviceID", @"\\.\PHYSICALDRIVE0"),
                ("Index", 0),
                ("PNPDeviceID", @"SCSI\DISK&VEN_SAMSUNG&PROD_MZ7LH256\4&1E59B6B1&0&000000"),
                ("Model", "SAMSUNG MZ7LH256"),
                ("SerialNumber", "S4EVNF0M123456")),
            FakeWmiRepository.Row(
                ("DeviceID", @"\\.\PHYSICALDRIVE1"),
                ("Index", 1),
                ("PNPDeviceID", @"SCSI\DISK&VEN_ST&PROD_ST1000DM003\5&2AB3EC2A&0&000000"),
                ("Model", "ST1000DM003"),
                ("SerialNumber", "W1D2ABCD")),
        };

        var diskToPartition = new[]
        {
            Association(@"Win32_DiskDrive.DeviceID=""\\\\.\\PHYSICALDRIVE0""", @"Win32_DiskPartition.DeviceID=""Disk #0, Partition #1"""),
            Association(@"Win32_DiskDrive.DeviceID=""\\\\.\\PHYSICALDRIVE1""", @"Win32_DiskPartition.DeviceID=""Disk #1, Partition #0"""),
        };

        var partitionToLogical = new[]
        {
            Association(@"Win32_DiskPartition.DeviceID=""Disk #0, Partition #1""", @"Win32_LogicalDisk.DeviceID=""C:"""),
            Association(@"Win32_DiskPartition.DeviceID=""Disk #1, Partition #0""", @"Win32_LogicalDisk.DeviceID=""D:"""),
        };

        var map = DiskTopology.MapDriveLetters(diskDrives, diskToPartition, partitionToLogical);

        Assert.Equal(2, map.Count);
        Assert.Equal("SAMSUNG MZ7LH256", map["C"].Model);
        Assert.Equal("ST1000DM003", map["D"].Model);
    }

    [Fact]
    public void MapDriveLetters_IgnoresPartitionsWithNoDriveLetter()
    {
        var diskDrives = new[]
        {
            FakeWmiRepository.Row(("DeviceID", @"\\.\PHYSICALDRIVE0"), ("Model", "Boot disk")),
        };

        var diskToPartition = new[]
        {
            Association(@"Win32_DiskDrive.DeviceID=""\\\\.\\PHYSICALDRIVE0""", @"Win32_DiskPartition.DeviceID=""Disk #0, Partition #0"""),
        };

        // An EFI system partition has no logical disk association at all.
        var map = DiskTopology.MapDriveLetters(diskDrives, diskToPartition, Array.Empty<WmiRecord>());

        Assert.Empty(map);
    }

    [Fact]
    public void MatchSmartInstance_CorrelatesByThePhysicalDriveNumber()
    {
        // The trailing "_0" is the physical drive number, not a decorative
        // suffix, and it is the only part of the instance name that reliably
        // says which drive the row describes.
        var disk = new PhysicalDisk
        {
            Index = 0,
            DeviceId = @"\\.\PHYSICALDRIVE0",
            PnpDeviceId = @"SCSI\DISK&VEN_SAMSUNG&PROD_MZ7LH256\4&1E59B6B1&0&000000",
        };

        var matched = DiskTopology.MatchSmartInstance(
            @"SCSI\Disk&Ven_SAMSUNG&Prod_MZ7LH256\4&1e59b6b1&0&000000_0",
            new[] { disk });

        Assert.Same(disk, matched);
    }

    [Fact]
    public void MatchSmartInstance_DoesNotDependOnTheOrderRowsArriveIn()
    {
        // Win32_DiskDrive and the SMART classes do not return drives in the
        // same order, and nothing obliges them to. Code that paired them by
        // position would attribute drive 1's SMART data to drive 0 — on a
        // cabinet with a healthy system disk and a failing data disk, the
        // difference between replacing the right drive and the wrong one.
        var driveZero = new PhysicalDisk
        {
            Index = 0,
            DeviceId = @"\\.\PHYSICALDRIVE0",
            PnpDeviceId = @"SCSI\DISK&VEN_SAMSUNG\4&1E59B6B1&0&000000",
        };

        var driveOne = new PhysicalDisk
        {
            Index = 1,
            DeviceId = @"\\.\PHYSICALDRIVE1",
            PnpDeviceId = @"SCSI\DISK&VEN_ST\5&2AB3EC2A&0&000000",
        };

        // Deliberately reversed relative to the drive numbers.
        var disks = new[] { driveOne, driveZero };

        Assert.Same(driveZero, DiskTopology.MatchSmartInstance(@"SCSI\Disk&Ven_SAMSUNG\anything_0", disks));
        Assert.Same(driveOne, DiskTopology.MatchSmartInstance(@"SCSI\Disk&Ven_ST\anything_1", disks));
    }

    [Theory]
    [InlineData(@"SCSI\Disk&Ven_X\4&1e59b6b1&0&000000_0", 0)]
    [InlineData(@"SCSI\Disk&Ven_X\4&1e59b6b1&0&000000_11", 11)]
    [InlineData(@"IDE\Disk_Other\1&2&3_2", 2)]
    public void ParsePhysicalDriveNumber_ReadsTheTrailingDriveNumber(string instanceName, int expected) =>
        Assert.Equal(expected, DiskTopology.ParsePhysicalDriveNumber(instanceName));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(@"SCSI\Disk&Ven_X\4&1e59b6b1&0&000000")]
    [InlineData(@"SCSI\Disk&Ven_X\4&1e59b6b1&0&000000_")]
    [InlineData(@"SCSI\Disk&Ven_X\4&1e59b6b1&0&000000_abc")]
    public void ParsePhysicalDriveNumber_ReturnsNullWhenThereIsNoDriveNumber(string? instanceName) =>
        Assert.Null(DiskTopology.ParsePhysicalDriveNumber(instanceName));

    private static WmiRecord Association(string antecedent, string dependent)
        => FakeWmiRepository.Row(
            ("Antecedent", $@"\\CABINET-07\root\cimv2:{antecedent}"),
            ("Dependent", $@"\\CABINET-07\root\cimv2:{dependent}"));

    [Fact]
    public void MatchSmartInstance_ReturnsNullWhenNothingMatches()
    {
        var disk = new PhysicalDisk
        {
            Index = 0,
            DeviceId = @"\\.\PHYSICALDRIVE0",
            PnpDeviceId = @"SCSI\DISK&VEN_SAMSUNG&PROD_MZ7LH256\4&1E59B6B1&0&000000",
        };

        // Drive 3 is not present on this machine. The row is dropped rather
        // than attached to whatever happened to be nearby.
        Assert.Null(DiskTopology.MatchSmartInstance(@"IDE\DISK_OTHER\1&2&3_3", new[] { disk }));

        // An instance name with no drive number correlates to nothing.
        Assert.Null(DiskTopology.MatchSmartInstance(@"IDE\DISK_OTHER\1&2&3", new[] { disk }));
        Assert.Null(DiskTopology.MatchSmartInstance(null, new[] { disk }));
    }
}

public class BitLockerStatusTests
{
    [Fact]
    public void ALockedVolumeIsReportedAsLockedWhateverElseIsSaid()
    {
        // This is the state a cabinet sits in when it fails to unseal at boot.
        Assert.Equal(
            BitLockerStatus.EncryptedLocked,
            DiskCollector.DeriveBitLockerStatus(protectionStatus: 0, conversionStatus: 1, lockStatus: 1));
    }

    [Fact]
    public void EncryptionInProgressIsNotReportedAsEncrypted()
    {
        Assert.Equal(
            BitLockerStatus.EncryptionInProgress,
            DiskCollector.DeriveBitLockerStatus(protectionStatus: 1, conversionStatus: 2, lockStatus: 0));
    }

    [Fact]
    public void DecryptionInProgressIsDistinctFromNotEncrypted()
    {
        Assert.Equal(
            BitLockerStatus.DecryptionInProgress,
            DiskCollector.DeriveBitLockerStatus(protectionStatus: 1, conversionStatus: 3, lockStatus: 0));
    }

    [Fact]
    public void ProtectionOffOnAFullyEncryptedVolumeIsSuspendedNotUnencrypted()
    {
        // Suspended means the key protectors are off but the data is still
        // encrypted. Reporting it as unencrypted would be a false finding on a
        // DEA-audited machine; reporting it as encrypted would hide a real one.
        Assert.Equal(
            BitLockerStatus.Suspended,
            DiskCollector.DeriveBitLockerStatus(protectionStatus: 0, conversionStatus: 1, lockStatus: 0));
    }

    [Fact]
    public void ProtectionOnAndFullyEncryptedIsEncryptedUnlocked()
    {
        Assert.Equal(
            BitLockerStatus.EncryptedUnlocked,
            DiskCollector.DeriveBitLockerStatus(protectionStatus: 1, conversionStatus: 1, lockStatus: 0));
    }

    [Fact]
    public void AFullyDecryptedVolumeIsNotEncrypted()
    {
        Assert.Equal(
            BitLockerStatus.NotEncrypted,
            DiskCollector.DeriveBitLockerStatus(protectionStatus: 0, conversionStatus: 0, lockStatus: 0));
    }

    [Fact]
    public void NothingReadableIsUnknown()
    {
        Assert.Equal(
            BitLockerStatus.Unknown,
            DiskCollector.DeriveBitLockerStatus(protectionStatus: null, conversionStatus: null, lockStatus: null));
    }
}

public class DiskCollectorTests
{
    [Fact]
    public async Task CollectAsync_AttachesSmartDataToTheCorrectDriveLetter()
    {
        var vendorSpecific = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 0)
            .WithAttribute(SmartAttributeIds.PowerOnHours, raw: 26_304)
            .WithAttribute(SmartAttributeIds.TemperatureCelsius, raw: 31)
            .WithAttribute(SmartAttributeIds.CurrentPendingSectorCount, raw: 0)
            .Build();

        var wmi = new FakeWmiRepository()
            .Returns(
                "MSFT_Volume",
                FakeWmiRepository.Row(
                    ("DriveLetter", "C"),
                    ("FileSystemLabel", "OS"),
                    ("FileSystem", "NTFS"),
                    ("Size", 255_000_000_000L),
                    ("SizeRemaining", 64_000_000_000L)))
            .Returns(
                "Win32_DiskDrive",
                FakeWmiRepository.Row(
                    ("DeviceID", @"\\.\PHYSICALDRIVE0"),
                    ("Index", 0),
                    ("PNPDeviceID", @"SCSI\DISK&VEN_SAMSUNG&PROD_MZ7LH256\4&1E59B6B1&0&000000"),
                    ("Model", "SAMSUNG MZ7LH256"),
                    ("SerialNumber", "S4EVNF0M123456")))
            .Returns(
                "Win32_DiskDriveToDiskPartition",
                Association(@"Win32_DiskDrive.DeviceID=""\\\\.\\PHYSICALDRIVE0""", @"Win32_DiskPartition.DeviceID=""Disk #0, Partition #1"""))
            .Returns(
                "Win32_LogicalDiskToPartition",
                Association(@"Win32_DiskPartition.DeviceID=""Disk #0, Partition #1""", @"Win32_LogicalDisk.DeviceID=""C:"""))
            .Returns(
                "MSStorageDriver_FailurePredictStatus",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_SAMSUNG&Prod_MZ7LH256\4&1e59b6b1&0&000000_0"),
                    ("PredictFailure", false)))
            .Returns(
                "MSStorageDriver_FailurePredictData",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_SAMSUNG&Prod_MZ7LH256\4&1e59b6b1&0&000000_0"),
                    ("VendorSpecific", vendorSpecific)))
            .Returns(
                "Win32_EncryptableVolume",
                FakeWmiRepository.Row(
                    ("DeviceID", @"\\?\Volume{guid}\"),
                    ("DriveLetter", "C:"),
                    ("ProtectionStatus", 1)));

        var draft = new CheckInDraft();
        await new DiskCollector(wmi, new SmartReader(wmi, NullLogger<SmartReader>.Instance), NullLogger<DiskCollector>.Instance)
            .CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        var disk = Assert.Single(draft.Disks!);
        Assert.Equal("C", disk.DriveLetter);
        Assert.Equal("OS", disk.Label);
        Assert.Equal("NTFS", disk.FileSystem);
        Assert.Equal(255_000_000_000L, disk.TotalBytes);
        Assert.Equal(64_000_000_000L, disk.FreeBytes);
        Assert.Equal(25.1, disk.FreePercent);

        Assert.NotNull(disk.Smart);
        Assert.Equal(26_304, disk.Smart!.PowerOnHours);
        Assert.Equal(31, disk.Smart.TemperatureCelsius);
        Assert.Equal("SAMSUNG MZ7LH256", disk.Smart.Model);
        Assert.Equal(DiskHealthStatus.Healthy, disk.HealthStatus);
    }

    [Fact]
    public async Task CollectAsync_ReportsUnknownHealthWhenSmartIsUnavailable()
    {
        // A virtual machine or a USB-bridged drive exposes no SMART at all.
        // The volume must still be reported, with health Unknown rather than a
        // fabricated Healthy.
        var wmi = new FakeWmiRepository()
            .Returns(
                "MSFT_Volume",
                FakeWmiRepository.Row(
                    ("DriveLetter", "C"),
                    ("Size", 100_000_000_000L),
                    ("SizeRemaining", 50_000_000_000L)))
            .Returns("Win32_DiskDrive", FakeWmiRepository.Row(("DeviceID", @"\\.\PHYSICALDRIVE0")))
            .Throws("MSStorageDriver_FailurePredictStatus", new InvalidOperationException("Not supported"));

        var draft = new CheckInDraft();
        await new DiskCollector(wmi, new SmartReader(wmi, NullLogger<SmartReader>.Instance), NullLogger<DiskCollector>.Instance)
            .CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        var disk = Assert.Single(draft.Disks!);
        Assert.Null(disk.Smart);
        Assert.Equal(DiskHealthStatus.Unknown, disk.HealthStatus);
        Assert.Equal(50.0, disk.FreePercent);
    }

    [Fact]
    public async Task CollectAsync_ReportsWatchWhenADriveHasReallocatedSectors()
    {
        var vendorSpecific = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 24)
            .WithAttribute(SmartAttributeIds.CurrentPendingSectorCount, raw: 0)
            .Build();

        var wmi = new FakeWmiRepository()
            .Returns("MSFT_Volume", FakeWmiRepository.Row(("DriveLetter", "C"), ("Size", 1L), ("SizeRemaining", 1L)))
            .Returns(
                "Win32_DiskDrive",
                FakeWmiRepository.Row(
                    ("DeviceID", @"\\.\PHYSICALDRIVE0"),
                    ("Index", 0),
                    ("SerialNumber", "S4EVNF0M123456"),
                    ("PNPDeviceID", @"SCSI\DISK\X")))
            .Returns(
                "Win32_DiskDriveToDiskPartition",
                Association(@"Win32_DiskDrive.DeviceID=""\\\\.\\PHYSICALDRIVE0""", @"Win32_DiskPartition.DeviceID=""Disk #0, Partition #1"""))
            .Returns(
                "Win32_LogicalDiskToPartition",
                Association(@"Win32_DiskPartition.DeviceID=""Disk #0, Partition #1""", @"Win32_LogicalDisk.DeviceID=""C:"""))
            .Returns(
                "MSStorageDriver_FailurePredictStatus",
                FakeWmiRepository.Row(("InstanceName", @"SCSI\Disk\X_0"), ("PredictFailure", false)))
            .Returns(
                "MSStorageDriver_FailurePredictData",
                FakeWmiRepository.Row(("InstanceName", @"SCSI\Disk\X_0"), ("VendorSpecific", vendorSpecific)));

        var draft = new CheckInDraft();
        await new DiskCollector(wmi, new SmartReader(wmi, NullLogger<SmartReader>.Instance), NullLogger<DiskCollector>.Instance)
            .CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        var disk = Assert.Single(draft.Disks!);
        Assert.Equal(24, disk.Smart!.ReallocatedSectorCount);
        Assert.Equal(DiskHealthStatus.Watch, disk.HealthStatus);
    }

    private static WmiRecord Association(string antecedent, string dependent)
        => FakeWmiRepository.Row(
            ("Antecedent", $@"\\CABINET-07\root\cimv2:{antecedent}"),
            ("Dependent", $@"\\CABINET-07\root\cimv2:{dependent}"));
}
