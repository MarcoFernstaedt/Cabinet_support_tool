using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Collectors;

/// <summary>
/// The three SMART sources, their order of preference, and what happens when
/// each of them is missing.
/// </summary>
/// <remarks>
/// The two defects these tests exist to hold closed are not hypothetical. One
/// is attributing a drive's SMART data to a different drive by pairing two WMI
/// collections positionally; the other is treating the vendor-specific byte
/// array as the primary source when it is absent on USB-attached drives, on
/// many virtual machines, and wherever the vendor driver does not expose it.
/// Both are invisible until the failure prediction is wrong about a drive.
/// </remarks>
public class SmartReaderTests
{
    private static readonly PhysicalDisk DriveZero = new()
    {
        Index = 0,
        DeviceId = @"\\.\PHYSICALDRIVE0",
        PnpDeviceId = @"SCSI\DISK&VEN_SAMSUNG\4&1E59B6B1&0&000000",
        Model = "SAMSUNG MZ7LH256",
        SerialNumber = "S4EVNF0M123456",
    };

    private static readonly PhysicalDisk DriveOne = new()
    {
        Index = 1,
        DeviceId = @"\\.\PHYSICALDRIVE1",
        PnpDeviceId = @"SCSI\DISK&VEN_ST\5&2AB3EC2A&0&000000",
        Model = "ST1000DM003",
        SerialNumber = "W1D2ABCD",
    };

    [Fact]
    public void Read_PrefersTheStructuredReliabilityCounters()
    {
        // MSFT_StorageReliabilityCounter is documented and named. The vendor
        // byte array is neither, so when both answer the structured one wins
        // and the reading says so.
        var wmi = new FakeWmiRepository()
            .Returns(
                "MSFT_StorageReliabilityCounter",
                FakeWmiRepository.Row(
                    ("DeviceId", "0"),
                    ("Wear", 4),
                    ("ReadErrorsTotal", 91L),
                    ("ReadErrorsUncorrected", 0L),
                    ("WriteErrorsTotal", 3L),
                    ("WriteErrorsUncorrected", 1L),
                    ("PowerOnHours", 26_304),
                    ("Temperature", 31),
                    ("TemperatureMax", 47),
                    ("StartStopCycleCount", 812)))
            .Returns(
                "MSStorageDriver_FailurePredictData",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_SAMSUNG\4&1e59b6b1&0&000000_0"),
                    ("VendorSpecific", new SmartDataBuilder()
                        .WithAttribute(SmartAttributeIds.PowerOnHours, raw: 9)
                        .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 7)
                        .Build())));

        SmartInfo smart = Read(wmi)[0];

        Assert.Equal(SmartSource.StorageReliabilityCounter, smart.Source);
        Assert.Equal(4, smart.Wear);
        Assert.Equal(91, smart.ReadErrorsTotal);
        Assert.Equal(1, smart.WriteErrorsUncorrected);
        Assert.Equal(47, smart.TemperatureMax);
        Assert.Equal(812, smart.StartStopCycleCount);

        // The structured source's power-on hours win over the decoded ones.
        Assert.Equal(26_304, smart.PowerOnHours);

        // The vendor array still fills what the structured source has no field
        // for. Discarding a reallocated-sector count because a better source
        // answered on other attributes would lose the reading that matters most.
        Assert.Equal(7, smart.ReallocatedSectorCount);
    }

    [Fact]
    public void Read_FallsBackToThePredictionStatusWhenCountersAreAbsent()
    {
        // The reliability counter class is not implemented by every driver.
        // The drive's own verdict is still the single most actionable thing it
        // reports, so it is read on its own.
        var wmi = new FakeWmiRepository()
            .Returns(
                "MSStorageDriver_FailurePredictStatus",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_SAMSUNG\4&1e59b6b1&0&000000_0"),
                    ("PredictFailure", true),
                    ("Reason", 5)));

        SmartInfo smart = Read(wmi)[0];

        Assert.Equal(SmartSource.FailurePredictStatus, smart.Source);
        Assert.True(smart.OverallPredictFailure);
        Assert.Equal(5, smart.PredictFailureReason);

        // No counter was read. Every one stays null; none becomes zero.
        Assert.Null(smart.ReallocatedSectorCount);
        Assert.Null(smart.PendingSectorCount);
        Assert.Null(smart.PowerOnHours);
        Assert.Null(smart.Wear);
    }

    [Fact]
    public void Read_FallsBackToDecodedVendorBytesLast()
    {
        var wmi = new FakeWmiRepository()
            .Returns(
                "MSStorageDriver_FailurePredictData",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_SAMSUNG\4&1e59b6b1&0&000000_0"),
                    ("VendorSpecific", new SmartDataBuilder()
                        .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 24)
                        .WithAttribute(SmartAttributeIds.CurrentPendingSectorCount, raw: 3)
                        .WithAttribute(SmartAttributeIds.UncorrectableSectorCount, raw: 1)
                        .WithAttribute(SmartAttributeIds.PowerOnHours, raw: 41_000)
                        .WithAttribute(SmartAttributeIds.TemperatureCelsius, raw: 38)
                        .Build())));

        SmartInfo smart = Read(wmi)[0];

        Assert.Equal(SmartSource.FailurePredictData, smart.Source);
        Assert.Equal(24, smart.ReallocatedSectorCount);
        Assert.Equal(3, smart.PendingSectorCount);
        Assert.Equal(1, smart.UncorrectableErrorCount);
        Assert.Equal(41_000, smart.PowerOnHours);
        Assert.Equal(38, smart.TemperatureCelsius);

        // Attributes the vendor array does not carry stay null rather than
        // becoming zero, which on a wear figure would read as a new drive.
        Assert.Null(smart.Wear);
        Assert.Null(smart.ReadErrorsTotal);
        Assert.Null(smart.TemperatureMax);
    }

    [Fact]
    public void Read_ReturnsNothingForADriveNoSourceAnswersFor()
    {
        // The whole point. A drive with no readable SMART gets no SmartInfo at
        // all, which is what makes its health Unknown rather than Healthy. A
        // zeroed counter here would look like a pristine drive and would poison
        // every trend built on top of it.
        IReadOnlyDictionary<int, SmartInfo> readings = Read(new FakeWmiRepository());

        Assert.Empty(readings);
    }

    [Fact]
    public void Read_CorrelatesEachSourceToItsOwnDriveRegardlessOfRowOrder()
    {
        // This is the ordering defect. Win32_DiskDrive and the SMART classes do
        // not return drives in the same order and are not obliged to. Pairing
        // them by position attributes the failing drive's reallocated sectors
        // to the healthy one — so the fleet view shows a healthy cabinet and
        // the drive that is actually dying is never replaced.
        var wmi = new FakeWmiRepository()
            .Returns(
                "MSFT_StorageReliabilityCounter",
                // Reversed relative to the drive list.
                FakeWmiRepository.Row(("DeviceId", "1"), ("Wear", 88), ("PowerOnHours", 60_000)),
                FakeWmiRepository.Row(("DeviceId", "0"), ("Wear", 2), ("PowerOnHours", 900)))
            .Returns(
                "MSStorageDriver_FailurePredictStatus",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_ST\5&2ab3ec2a&0&000000_1"),
                    ("PredictFailure", true),
                    ("Reason", 2)),
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_SAMSUNG\4&1e59b6b1&0&000000_0"),
                    ("PredictFailure", false),
                    ("Reason", 0)));

        IReadOnlyDictionary<int, SmartInfo> readings = Read(wmi, DriveZero, DriveOne);

        // Drive 0 is the healthy young system disk.
        Assert.Equal(2, readings[0].Wear);
        Assert.Equal(900, readings[0].PowerOnHours);
        Assert.False(readings[0].OverallPredictFailure);
        Assert.Equal("S4EVNF0M123456", readings[0].SerialNumber);

        // Drive 1 is the worn one predicting its own failure.
        Assert.Equal(88, readings[1].Wear);
        Assert.Equal(60_000, readings[1].PowerOnHours);
        Assert.True(readings[1].OverallPredictFailure);
        Assert.Equal(2, readings[1].PredictFailureReason);
        Assert.Equal("W1D2ABCD", readings[1].SerialNumber);
    }

    [Fact]
    public void Read_DropsARowNamingADriveThisMachineDoesNotHave()
    {
        // A row for drive 3 on a machine with one drive is not drive 0's data.
        var wmi = new FakeWmiRepository()
            .Returns(
                "MSFT_StorageReliabilityCounter",
                FakeWmiRepository.Row(("DeviceId", "3"), ("Wear", 99)))
            .Returns(
                "MSStorageDriver_FailurePredictStatus",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_Other\1&2&3_3"), ("PredictFailure", true)));

        Assert.Empty(Read(wmi));
    }

    [Fact]
    public void Read_RejectsAnImplausibleTemperature()
    {
        // A drive reporting 0 °C is a drive whose firmware fills the field with
        // something else. Unknown beats wrong: shown as "not read", it sends
        // nobody looking for a cooling fault that is not there.
        var wmi = new FakeWmiRepository()
            .Returns(
                "MSFT_StorageReliabilityCounter",
                FakeWmiRepository.Row(
                    ("DeviceId", "0"), ("Temperature", 0), ("TemperatureMax", 300), ("Wear", 1)));

        SmartInfo smart = Read(wmi)[0];

        Assert.Null(smart.TemperatureCelsius);
        Assert.Null(smart.TemperatureMax);
        Assert.Equal(1, smart.Wear);
    }

    [Fact]
    public void Read_SurvivesASourceThatThrows()
    {
        // The storage namespace is absent on older builds and the root\wmi
        // classes are absent on virtual machines. One source failing must not
        // cost the readings the others produced.
        var wmi = new FakeWmiRepository()
            .Throws("MSFT_StorageReliabilityCounter", new InvalidOperationException("Namespace not found."))
            .Returns(
                "MSStorageDriver_FailurePredictStatus",
                FakeWmiRepository.Row(
                    ("InstanceName", @"SCSI\Disk&Ven_SAMSUNG\4&1e59b6b1&0&000000_0"),
                    ("PredictFailure", false)));

        SmartInfo smart = Read(wmi)[0];

        Assert.Equal(SmartSource.FailurePredictStatus, smart.Source);
        Assert.False(smart.OverallPredictFailure);
    }

    private static IReadOnlyDictionary<int, SmartInfo> Read(
        FakeWmiRepository wmi, params PhysicalDisk[] disks)
    {
        var reader = new SmartReader(wmi, NullLogger<SmartReader>.Instance);
        return reader.Read(disks.Length == 0 ? new[] { DriveZero } : disks);
    }
}
