using System.Buffers.Binary;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

/// <summary>storage.health without Windows: the NVMe health-log request, the drive's answer read safely, the log itself, and volume states.</summary>
public sealed class StorageHealthTests
{
    private static byte[] Log(Action<byte[]> fill)
    {
        var b = new byte[StorageHealth.LogBytes];
        fill(b);
        return b;
    }

    private static void Put128(byte[] b, int at, ulong low, ulong high = 0)
    {
        BinaryPrimitives.WriteUInt64LittleEndian(b.AsSpan(at), low);
        BinaryPrimitives.WriteUInt64LittleEndian(b.AsSpan(at + 8), high);
    }

    /// <summary>A drive's answer: the descriptor (Version, Size = 48), the protocol data with the log at <paramref name="offset"/>, then the log.</summary>
    private static byte[] Answer(byte[] log, uint offset = 40, uint length = 512, uint version = 48, uint size = 48)
    {
        int at = (int)Math.Clamp(offset, 40u, 1024u); // where the log is put; a hostile offset still says where it is not
        var b = new byte[8 + at + log.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0), version);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), size);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(8), 3);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(12), 2);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(16), 2);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(8 + 16), offset);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(8 + 20), length);
        log.CopyTo(b, 8 + at);
        return b;
    }

    private static readonly byte[] Worn = Log(b =>
    {
        b[0] = 0x01 | 0x04;                                         // spare below threshold, reliability degraded
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(1), 273 + 48);
        b[3] = 7; b[4] = 10; b[5] = 104;
        Put128(b, 32, 2_000_000); Put128(b, 48, 3_000_000);
        Put128(b, 112, 812); Put128(b, 128, 21_450); Put128(b, 144, 37); Put128(b, 160, 3); Put128(b, 176, 120);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(192), 15);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(196), 2);
    });

    [Fact]
    public void The_request_asks_the_drive_for_the_whole_health_log_page()
    {
        byte[] q = StorageHealth.NvmeHealthQuery();
        Assert.Equal(8 + 40 + 512, q.Length);
        uint At(int i) => BinaryPrimitives.ReadUInt32LittleEndian(q.AsSpan(i));
        Assert.Equal(50u, At(0));   // StorageDeviceProtocolSpecificProperty
        Assert.Equal(0u, At(4));    // PropertyStandardQuery
        Assert.Equal(3u, At(8));    // ProtocolTypeNvme
        Assert.Equal(2u, At(12));   // NVMeDataTypeLogPage
        Assert.Equal(2u, At(16));   // log page 02h, SMART / health information
        Assert.Equal(0u, At(20));   // from the start of the log
        Assert.Equal(40u, At(24));  // the log follows the protocol data
        Assert.Equal(512u, At(28));
    }

    [Fact]
    public void A_worn_drive_s_log_reads_as_its_warnings_and_counters()
    {
        var (h, problem) = StorageHealth.ReadNvmeAnswer(Answer(Worn), Answer(Worn).Length);
        Assert.Null(problem);
        Assert.NotNull(h);
        Assert.True(h!.CriticalWarnings.SpareBelowThreshold);
        Assert.True(h.CriticalWarnings.ReliabilityDegraded);
        Assert.False(h.CriticalWarnings.ReadOnly);
        Assert.False(h.CriticalWarnings.TemperatureOutOfRange);
        Assert.Equal(48, h.TemperatureCelsius);
        Assert.Equal(7, h.AvailableSparePercent);
        Assert.Equal(10, h.SpareThresholdPercent);
        Assert.Equal(104, h.PercentageUsed);
        Assert.Equal(2_000_000L * 512_000, h.DataReadBytes);
        Assert.Equal(3_000_000L * 512_000, h.DataWrittenBytes);
        Assert.Equal(812, h.PowerCycles);
        Assert.Equal(21_450, h.PowerOnHours);
        Assert.Equal(37, h.UnsafeShutdowns);
        Assert.Equal(3, h.MediaErrors);
        Assert.Equal(120, h.ErrorLogEntries);
        Assert.Equal(15, h.WarningTemperatureMinutes);
        Assert.Equal(2, h.CriticalTemperatureMinutes);
    }

    [Fact]
    public void The_log_is_found_wherever_the_answer_says_it_starts()
    {
        var (h, problem) = StorageHealth.ReadNvmeAnswer(Answer(Worn, offset: 64), Answer(Worn, offset: 64).Length);
        Assert.Null(problem);
        Assert.Equal(21_450, h!.PowerOnHours);
    }

    [Fact]
    public void Counters_past_what_the_contract_carries_are_held_at_its_limit_rather_than_wrapped()
    {
        var (h, _) = StorageHealth.ParseLog(Log(b =>
        {
            Put128(b, 32, 1, high: 1);              // a 128-bit count
            Put128(b, 48, ulong.MaxValue);          // a 64-bit count past 2^53
            Put128(b, 128, (ulong)StorageHealth.MaxCount);
            Put128(b, 144, (ulong)StorageHealth.MaxCount + 1);
        }));
        Assert.Equal(StorageHealth.MaxCount, h!.DataReadBytes);
        Assert.Equal(StorageHealth.MaxCount, h.DataWrittenBytes);
        Assert.Equal(StorageHealth.MaxCount, h.PowerOnHours);
        Assert.Equal(StorageHealth.MaxCount, h.UnsafeShutdowns);
        var (big, _) = StorageHealth.ParseLog(Log(b => Put128(b, 32, (ulong)(StorageHealth.MaxCount / 512_000) + 1)));
        Assert.Equal(StorageHealth.MaxCount, big!.DataReadBytes);
    }

    [Theory]
    [InlineData(0, null)]          // not reported
    [InlineData(273 + 35, 35)]
    [InlineData(273 - 40, -40)]
    [InlineData(273 + 150, 150)]
    [InlineData(273 + 151, null)]  // past what a drive can be
    [InlineData(65535, null)]
    public void Temperature_is_read_from_kelvin_and_anything_impossible_is_left_out(int kelvin, int? celsius)
    {
        var (h, _) = StorageHealth.ParseLog(Log(b => BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(1), (ushort)kelvin)));
        Assert.Equal(celsius, h!.TemperatureCelsius);
    }

    [Fact]
    public void Spare_percentages_past_100_are_left_out_but_wear_past_100_is_kept()
    {
        var (h, _) = StorageHealth.ParseLog(Log(b => { b[3] = 101; b[4] = 255; b[5] = 255; }));
        Assert.Null(h!.AvailableSparePercent);
        Assert.Null(h.SpareThresholdPercent);
        Assert.Equal(255, h.PercentageUsed);
    }

    [Fact]
    public void Every_warning_bit_has_its_own_flag_and_reserved_bits_are_ignored()
    {
        var (all, _) = StorageHealth.ParseLog(Log(b => b[0] = 0xFF));
        var w = all!.CriticalWarnings;
        Assert.True(w.SpareBelowThreshold && w.TemperatureOutOfRange && w.ReliabilityDegraded && w.ReadOnly && w.VolatileBackupFailed && w.PersistentMemoryReadOnly);
        var (none, _) = StorageHealth.ParseLog(Log(b => b[0] = 0xC0));
        var n = none!.CriticalWarnings;
        Assert.False(n.SpareBelowThreshold || n.TemperatureOutOfRange || n.ReliabilityDegraded || n.ReadOnly || n.VolatileBackupFailed || n.PersistentMemoryReadOnly);
    }

    public static TheoryData<string, byte[], long> BadAnswers()
    {
        byte[] good = Answer(Worn);
        return new TheoryData<string, byte[], long>
        {
            { "nothing returned", good, 0 },
            { "only the descriptor", good, 48 },
            { "one byte of the log missing", good, good.Length - 1 },
            { "more returned than the buffer holds", good, good.Length + 1 },
            { "negative length", good, -1 },
            { "wrong descriptor version", Answer(Worn, version: 40), good.Length },
            { "wrong descriptor size", Answer(Worn, size: 0), good.Length },
            { "the log said to start inside the protocol data", Answer(Worn, offset: 8), good.Length },
            { "a log shorter than the health log", Answer(Worn, length: 511), good.Length },
            { "the log said to start past the end", Answer(Worn, offset: uint.MaxValue - 8), good.Length },
            { "the log said to start past what was returned", Answer(Worn, offset: 41), good.Length },
        };
    }

    [Theory]
    [MemberData(nameof(BadAnswers))]
    public void An_answer_that_does_not_hold_a_whole_log_is_unreadable(string why, byte[] answer, long returned)
    {
        var (h, problem) = StorageHealth.ReadNvmeAnswer(answer, returned);
        Assert.True(h is null && problem == NvmeProblem.Unreadable, why);
    }

    [Fact]
    public void A_log_cut_short_is_unreadable()
    {
        Assert.Equal(NvmeProblem.Unreadable, StorageHealth.ParseLog(new byte[511]).Problem);
        Assert.Equal(NvmeProblem.Unreadable, StorageHealth.ParseLog(ReadOnlySpan<byte>.Empty).Problem);
    }

    [Theory]
    [InlineData(17L, StorageBus.Nvme)]
    [InlineData(11L, StorageBus.Sata)]
    [InlineData(10L, StorageBus.Sas)]
    [InlineData(7L, StorageBus.Usb)]
    [InlineData(8L, StorageBus.Raid)]
    [InlineData(0L, StorageBus.Unknown)]
    [InlineData(null, StorageBus.Unknown)]
    [InlineData(3L, StorageBus.Other)]
    [InlineData(-5L, StorageBus.Other)]
    public void Bus_types_map_from_storage_management(long? busType, StorageBus bus) => Assert.Equal(bus, StorageHealth.BusOf(busType));

    [Fact]
    public void A_volume_s_repair_state_is_the_worst_its_status_asks_for()
    {
        Assert.Equal(VolumeRepair.Unknown, StorageHealth.RepairOf([]));
        Assert.Equal(VolumeRepair.None, StorageHealth.RepairOf([2]));
        Assert.Equal(VolumeRepair.ScanNeeded, StorageHealth.RepairOf([2, 0xD00D]));
        Assert.Equal(VolumeRepair.SpotFixNeeded, StorageHealth.RepairOf([0xD00D, 0xD00E]));
        Assert.Equal(VolumeRepair.FullRepairNeeded, StorageHealth.RepairOf([0xD00E, 0xD00F, 0xD00D]));
        Assert.Equal(VolumeHealth.Healthy, StorageHealth.VolumeHealthOf(0));
        Assert.Equal(VolumeHealth.Warning, StorageHealth.VolumeHealthOf(1));
        Assert.Equal(VolumeHealth.Unhealthy, StorageHealth.VolumeHealthOf(2));
        Assert.Equal(VolumeHealth.Unknown, StorageHealth.VolumeHealthOf(5));
        Assert.Equal(VolumeHealth.Unknown, StorageHealth.VolumeHealthOf(null));
    }

    [Theory]
    [InlineData("C", "C")]
    [InlineData("d", "D")]
    [InlineData("\0", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    [InlineData("CD", null)]
    [InlineData("1", null)]
    [InlineData("Ä", null)]
    [InlineData("\\", null)]
    public void Drive_letters_are_one_letter_or_none(string? text, string? letter) => Assert.Equal(letter, StorageHealth.LetterOf(text));

    [Theory]
    [InlineData("NTFS", VolumeFileSystem.Ntfs)]
    [InlineData("ReFS", VolumeFileSystem.Refs)]
    [InlineData("FAT32", VolumeFileSystem.Fat32)]
    [InlineData("exFAT", VolumeFileSystem.Exfat)]
    [InlineData("FAT", VolumeFileSystem.Fat)]
    [InlineData("CSVFS", VolumeFileSystem.Other)]
    [InlineData(" ", VolumeFileSystem.Unknown)]
    [InlineData(null, VolumeFileSystem.Unknown)]
    public void File_systems_map_to_the_contract_s_names(string? name, VolumeFileSystem fs) => Assert.Equal(fs, StorageHealth.FileSystemOf(name));

    [Fact]
    public void An_answer_built_from_these_parts_meets_the_contract()
    {
        var output = new StorageHealthOutput
        {
            TakenAt = new DateTimeOffset(2026, 11, 3, 9, 0, 0, TimeSpan.Zero),
            Drives =
            [
                new StorageDrive { Number = 0, Model = "NVMe SSD 512GB", Bus = StorageBus.Nvme, Nvme = StorageHealth.ParseLog(Worn).Health, NvmeProblem = null },
                new StorageDrive { Number = 1, Model = null, Bus = StorageBus.Sata, Nvme = null, NvmeProblem = NvmeProblem.NotNvme },
                new StorageDrive { Number = 2, Model = "USB stick", Bus = StorageBus.Usb, Nvme = null, NvmeProblem = NvmeProblem.NotNvme },
            ],
            Volumes =
            [
                new StorageVolume { Letter = "C", Label = "Windows", FileSystem = VolumeFileSystem.Ntfs, SizeBytes = 511_000_000_000, FreeBytes = 3_000_000_000,
                                    Health = VolumeHealth.Warning, Repair = VolumeRepair.SpotFixNeeded, Dirty = true },
                new StorageVolume { Letter = null, Label = null, FileSystem = VolumeFileSystem.Unknown, SizeBytes = 0, FreeBytes = 0,
                                    Health = VolumeHealth.Unknown, Repair = VolumeRepair.Unknown, Dirty = null },
            ],
        };
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.StorageHealth), JsonSerializer.SerializeToElement(output, ContractJson.Options)));
    }
}
