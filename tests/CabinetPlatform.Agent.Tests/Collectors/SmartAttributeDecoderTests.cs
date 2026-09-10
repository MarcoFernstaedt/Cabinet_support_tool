using CabinetPlatform.Agent.Collectors;

namespace CabinetPlatform.Agent.Tests.Collectors;

/// <summary>
/// The SMART decoder is the least forgiving code in the agent: a wrong offset
/// or a short read produces numbers that look entirely plausible while
/// describing a different attribute, and nothing downstream can detect it.
/// These tests pin the layout down byte by byte.
/// </summary>
public class SmartAttributeDecoderTests
{
    [Fact]
    public void Decode_ReadsAttributeIdsAndNormalisedValues()
    {
        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 0, current: 200, worst: 199, flags: 0x0033)
            .WithAttribute(SmartAttributeIds.PowerOnHours, raw: 12_345, current: 98, worst: 98, flags: 0x0032)
            .Build();

        var attributes = SmartAttributeDecoder.Decode(buffer);

        Assert.Equal(2, attributes.Count);

        Assert.Equal(SmartAttributeIds.ReallocatedSectorCount, attributes[0].Id);
        Assert.Equal(200, attributes[0].Current);
        Assert.Equal(199, attributes[0].Worst);
        Assert.Equal(0x0033, attributes[0].Flags);
        Assert.Equal(0, attributes[0].Raw);

        Assert.Equal(SmartAttributeIds.PowerOnHours, attributes[1].Id);
        Assert.Equal(12_345, attributes[1].Raw);
    }

    [Fact]
    public void Decode_StartsTheAttributeTableAtOffsetTwo()
    {
        // The two leading bytes are a revision word. If the decoder started at
        // offset 0 it would read the revision as an attribute id and every
        // subsequent record would be shifted, so a distinctive revision is used
        // here and must not appear as an attribute.
        var buffer = new SmartDataBuilder()
            .WithRevision(0x05, 0xC5)
            .WithAttribute(SmartAttributeIds.PowerOnHours, raw: 7)
            .Build();

        var attributes = SmartAttributeDecoder.Decode(buffer);

        var single = Assert.Single(attributes);
        Assert.Equal(SmartAttributeIds.PowerOnHours, single.Id);
        Assert.Equal(7, single.Raw);
    }

    [Fact]
    public void Decode_UsesTwelveByteRecords()
    {
        // Ten attributes only land on their expected ids if the stride is 12.
        var builder = new SmartDataBuilder();
        for (byte id = 1; id <= 10; id++)
        {
            builder.WithAttribute(id, raw: id * 1000L);
        }

        var attributes = SmartAttributeDecoder.Decode(builder.Build());

        Assert.Equal(10, attributes.Count);
        for (var index = 0; index < 10; index++)
        {
            Assert.Equal((byte)(index + 1), attributes[index].Id);
            Assert.Equal((index + 1) * 1000L, attributes[index].Raw);
        }
    }

    [Fact]
    public void Decode_ReadsRawValueAsSixLittleEndianBytes()
    {
        // A value that needs all six bytes. Read as four bytes it truncates to
        // 0x44332211; read big-endian it is a different number entirely.
        const long RawValue = 0x665544332211L;

        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.PowerOnHours, RawValue)
            .Build();

        var single = Assert.Single(SmartAttributeDecoder.Decode(buffer));
        Assert.Equal(RawValue, single.Raw);
    }

    [Fact]
    public void Decode_SkipsUnusedSlotsButKeepsLaterAttributes()
    {
        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 4)
            .WithEmptySlot()
            .WithAttribute(SmartAttributeIds.CurrentPendingSectorCount, raw: 9)
            .Build();

        var attributes = SmartAttributeDecoder.Decode(buffer);

        Assert.Equal(2, attributes.Count);
        Assert.Equal(SmartAttributeIds.ReallocatedSectorCount, attributes[0].Id);
        Assert.Equal(SmartAttributeIds.CurrentPendingSectorCount, attributes[1].Id);
        Assert.Equal(9, attributes[1].Raw);
    }

    [Fact]
    public void Decode_StopsAtThirtyAttributes()
    {
        // The ATA structure defines 30 slots. A buffer whose bytes past the
        // table happen to be non-zero must not be read as further attributes.
        var buffer = new byte[SmartDataBuilder.VendorSpecificLength];
        for (var i = 0; i < buffer.Length; i++)
        {
            buffer[i] = 0x7F;
        }

        var attributes = SmartAttributeDecoder.Decode(buffer);

        Assert.Equal(SmartAttributeDecoder.MaximumAttributeCount, attributes.Count);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    [InlineData(2)]
    [InlineData(13)]
    public void Decode_ReturnsEmptyForBuffersTooShortToHoldARecord(int? length)
    {
        var buffer = length is null ? null : new byte[length.Value];

        var attributes = SmartAttributeDecoder.Decode(buffer);

        Assert.Empty(attributes);
    }

    [Fact]
    public void Decode_DoesNotThrowOnATruncatedTable()
    {
        // Some controllers return fewer than 512 bytes. Two full records fit in
        // 26 bytes; the third is cut short and must simply not be read.
        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 1)
            .WithAttribute(SmartAttributeIds.CurrentPendingSectorCount, raw: 2)
            .Build(length: 30);

        var attributes = SmartAttributeDecoder.Decode(buffer);

        Assert.Equal(2, attributes.Count);
    }

    [Fact]
    public void ReadRawValue_AssemblesBytesLittleEndian()
    {
        var buffer = new byte[] { 0xFF, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xFF };

        var raw = SmartAttributeDecoder.ReadRawValue(buffer, offset: 1);

        Assert.Equal(0x060504030201L, raw);
    }

    [Fact]
    public void ToSmartInfo_MapsTheFiveRequiredAttributes()
    {
        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 12)
            .WithAttribute(SmartAttributeIds.PowerOnHours, raw: 41_000)
            .WithAttribute(SmartAttributeIds.TemperatureCelsius, raw: 38)
            .WithAttribute(SmartAttributeIds.CurrentPendingSectorCount, raw: 3)
            .WithAttribute(SmartAttributeIds.UncorrectableSectorCount, raw: 1)
            .Build();

        var smart = SmartAttributeDecoder.ToSmartInfo(
            SmartAttributeDecoder.Decode(buffer),
            overallPredictFailure: false,
            model: "SAMSUNG MZ7LH256",
            serialNumber: "S4EVNF0M123456");

        Assert.Equal(12, smart.ReallocatedSectorCount);
        Assert.Equal(41_000, smart.PowerOnHours);
        Assert.Equal(38, smart.TemperatureCelsius);
        Assert.Equal(3, smart.PendingSectorCount);
        Assert.Equal(1, smart.UncorrectableErrorCount);
        Assert.False(smart.OverallPredictFailure);
        Assert.Equal("SAMSUNG MZ7LH256", smart.Model);
        Assert.Equal("S4EVNF0M123456", smart.SerialNumber);
    }

    [Fact]
    public void ToSmartInfo_LeavesAbsentAttributesNullRatherThanZero()
    {
        // This is the rule that matters most. Zero reallocated sectors is the
        // reading that means "this drive is fine"; reporting it for an
        // attribute the drive never sent would hide a failing disk.
        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.PowerOnHours, raw: 100)
            .Build();

        var smart = SmartAttributeDecoder.ToSmartInfo(
            SmartAttributeDecoder.Decode(buffer),
            overallPredictFailure: null);

        Assert.Null(smart.ReallocatedSectorCount);
        Assert.Null(smart.PendingSectorCount);
        Assert.Null(smart.UncorrectableErrorCount);
        Assert.Null(smart.TemperatureCelsius);
        Assert.Null(smart.OverallPredictFailure);
        Assert.Equal(100, smart.PowerOnHours);
    }

    [Fact]
    public void ToSmartInfo_ReadsOnlyTheLowByteOfTheTemperatureAttribute()
    {
        // Drives commonly pack lifetime min and max into the upper bytes of
        // attribute 0xC2. Reading the whole raw field gives nonsense like
        // 2359333, so only the low byte is the current reading.
        const long PackedTemperature = (55L << 32) | (18L << 16) | 34L;

        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.TemperatureCelsius, PackedTemperature)
            .Build();

        var smart = SmartAttributeDecoder.ToSmartInfo(
            SmartAttributeDecoder.Decode(buffer),
            overallPredictFailure: false);

        Assert.Equal(34, smart.TemperatureCelsius);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(200)]
    public void ToSmartInfo_RejectsImplausibleTemperatures(long raw)
    {
        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.TemperatureCelsius, raw)
            .Build();

        var smart = SmartAttributeDecoder.ToSmartInfo(
            SmartAttributeDecoder.Decode(buffer),
            overallPredictFailure: false);

        Assert.Null(smart.TemperatureCelsius);
    }

    [Fact]
    public void ToSmartInfo_ClampsRawValuesWiderThanTheContractsField()
    {
        // The raw field is 48 bits and the contract's is 32. An unchecked cast
        // would wrap to a negative count, which reads as healthier than clean.
        var buffer = new SmartDataBuilder()
            .WithAttribute(SmartAttributeIds.ReallocatedSectorCount, raw: 0xFFFFFFFFFFL)
            .Build();

        var smart = SmartAttributeDecoder.ToSmartInfo(
            SmartAttributeDecoder.Decode(buffer),
            overallPredictFailure: false);

        Assert.Equal(int.MaxValue, smart.ReallocatedSectorCount);
    }

    [Fact]
    public void Decode_HandlesARealisticFullAttributeTable()
    {
        // A table shaped like one from a healthy SATA SSD in service.
        var buffer = new SmartDataBuilder()
            .WithAttribute(0x05, raw: 0, current: 100, worst: 100, flags: 0x0033)
            .WithAttribute(0x09, raw: 26_304, current: 97, worst: 97, flags: 0x0032)
            .WithAttribute(0x0C, raw: 1_842, current: 99, worst: 99, flags: 0x0032)
            .WithAttribute(0xB1, raw: 4, current: 99, worst: 99, flags: 0x0032)
            .WithAttribute(0xC2, raw: 31, current: 69, worst: 47, flags: 0x0022)
            .WithAttribute(0xC5, raw: 0, current: 100, worst: 100, flags: 0x0032)
            .WithAttribute(0xC6, raw: 0, current: 100, worst: 100, flags: 0x001E)
            .WithAttribute(0xF1, raw: 15_338_729_472L, current: 99, worst: 99, flags: 0x0032)
            .Build();

        var attributes = SmartAttributeDecoder.Decode(buffer);
        var smart = SmartAttributeDecoder.ToSmartInfo(attributes, overallPredictFailure: false);

        Assert.Equal(8, attributes.Count);
        Assert.Equal(0, smart.ReallocatedSectorCount);
        Assert.Equal(26_304, smart.PowerOnHours);
        Assert.Equal(31, smart.TemperatureCelsius);
        Assert.Equal(0, smart.PendingSectorCount);
        Assert.Equal(0, smart.UncorrectableErrorCount);

        // Total host writes needs all six raw bytes to survive intact.
        var hostWrites = Assert.Single(attributes, a => a.Id == 0xF1);
        Assert.Equal(15_338_729_472L, hostWrites.Raw);
    }
}
