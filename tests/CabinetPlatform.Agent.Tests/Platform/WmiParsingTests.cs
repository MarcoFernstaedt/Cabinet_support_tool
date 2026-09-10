using CabinetPlatform.Agent.Platform.Wmi;

namespace CabinetPlatform.Agent.Tests.Platform;

public class CimDateTimeTests
{
    [Fact]
    public void TryParse_ReadsTheOffsetAsMinutesNotHours()
    {
        // -300 is five hours behind UTC. Read as hours it would be an invalid
        // offset; read as minutes but unsigned it would land five hours the
        // wrong way, quietly shifting every timestamp the agent reports.
        var parsed = CimDateTime.TryParse("20240115103000.000000-300");

        Assert.NotNull(parsed);
        Assert.Equal(TimeSpan.FromHours(-5), parsed!.Value.Offset);
        Assert.Equal(new DateTime(2024, 1, 15, 10, 30, 0), parsed.Value.DateTime);
        Assert.Equal(new DateTimeOffset(2024, 1, 15, 15, 30, 0, TimeSpan.Zero), parsed.Value.ToUniversalTime());
    }

    [Fact]
    public void TryParse_HandlesAPositiveOffset()
    {
        var parsed = CimDateTime.TryParse("20240701120000.000000+330");

        Assert.NotNull(parsed);
        Assert.Equal(TimeSpan.FromMinutes(330), parsed!.Value.Offset);
    }

    [Fact]
    public void TryParse_HandlesUtc()
    {
        var parsed = CimDateTime.TryParse("20260908060000.000000+000");

        Assert.NotNull(parsed);
        Assert.Equal(TimeSpan.Zero, parsed!.Value.Offset);
        Assert.Equal(new DateTimeOffset(2026, 9, 8, 6, 0, 0, TimeSpan.Zero), parsed.Value);
    }

    [Fact]
    public void TryParse_ReadsTheFractionAsMicroseconds()
    {
        var parsed = CimDateTime.TryParse("20240115103000.500000+000");

        Assert.NotNull(parsed);
        Assert.Equal(500, parsed!.Value.Millisecond);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a datetime")]
    [InlineData("20240115")]
    // An interval, not a point in time: it has no valid conversion.
    [InlineData("00000000001500.000000:000")]
    [InlineData("20240115103000.000000*300")]
    public void TryParse_RejectsWhatItCannotUnderstand(string? value)
    {
        Assert.Null(CimDateTime.TryParse(value));
    }
}

public class WmiReferenceTests
{
    private const string LogonSessionPath =
        @"\\CABINET-07\root\cimv2:Win32_LogonSession.LogonId=""4001""";

    private const string AccountPath =
        @"\\CABINET-07\root\cimv2:Win32_Account.Domain=""CLINIC"",Name=""jrivera""";

    [Fact]
    public void GetKeyValue_ReadsASingleKey()
    {
        Assert.Equal("4001", WmiReference.GetKeyValue(LogonSessionPath, "LogonId"));
    }

    [Fact]
    public void GetKeyValue_ReadsEachOfSeveralKeys()
    {
        Assert.Equal("CLINIC", WmiReference.GetKeyValue(AccountPath, "Domain"));
        Assert.Equal("jrivera", WmiReference.GetKeyValue(AccountPath, "Name"));
    }

    [Fact]
    public void GetKeyValue_IsCaseInsensitiveOnTheKeyName()
    {
        Assert.Equal("4001", WmiReference.GetKeyValue(LogonSessionPath, "logonid"));
    }

    [Fact]
    public void GetKeyValue_HandlesADeviceIdFullOfBackslashes()
    {
        // Physical drive paths are the reason this parser cannot just split on
        // punctuation: the value itself contains escaped separators.
        const string Path =
            @"\\CABINET-07\root\cimv2:Win32_DiskDrive.DeviceID=""\\\\.\\PHYSICALDRIVE0""";

        Assert.Equal(@"\\.\PHYSICALDRIVE0", WmiReference.GetKeyValue(Path, "DeviceID"));
    }

    [Fact]
    public void GetKeyValue_HandlesAPartitionIdContainingACommaAndSpaces()
    {
        // "Disk #0, Partition #1" contains the very character that separates
        // keys. Splitting naively loses everything after the comma.
        const string Path =
            @"\\CABINET-07\root\cimv2:Win32_DiskPartition.DeviceID=""Disk #0, Partition #1""";

        Assert.Equal("Disk #0, Partition #1", WmiReference.GetKeyValue(Path, "DeviceID"));
    }

    [Fact]
    public void GetKeyValue_ReturnsNullForAnAbsentKey()
    {
        Assert.Null(WmiReference.GetKeyValue(LogonSessionPath, "NoSuchKey"));
        Assert.Null(WmiReference.GetKeyValue(null, "LogonId"));
        Assert.Null(WmiReference.GetKeyValue("Win32_LogonSession", "LogonId"));
    }

    [Fact]
    public void GetClassName_ReadsTheClass()
    {
        Assert.Equal("Win32_LogonSession", WmiReference.GetClassName(LogonSessionPath));
        Assert.Equal("Win32_Account", WmiReference.GetClassName(AccountPath));
        Assert.Null(WmiReference.GetClassName(null));
    }
}

public class WmiRecordTests
{
    [Fact]
    public void TypedAccessors_ReturnNullForAnAbsentProperty()
    {
        var record = new WmiRecord(new Dictionary<string, object?>());

        // A property the agent could not read is unknown, never zero. On a
        // free-space or sector-count field the difference is the whole point.
        Assert.Null(record.GetString("Missing"));
        Assert.Null(record.GetInt32("Missing"));
        Assert.Null(record.GetInt64("Missing"));
        Assert.Null(record.GetDouble("Missing"));
        Assert.Null(record.GetBoolean("Missing"));
        Assert.Null(record.GetBytes("Missing"));
        Assert.Null(record.GetDateTime("Missing"));
    }

    [Fact]
    public void PropertyNamesAreCaseInsensitive()
    {
        var record = FakeWmiRepository.Row(("DeviceID", @"\\.\PHYSICALDRIVE0"));

        Assert.Equal(@"\\.\PHYSICALDRIVE0", record.GetString("deviceid"));
    }

    [Fact]
    public void GetInt64_ConvertsTheUnsignedTypesWmiActuallyReturns()
    {
        var record = FakeWmiRepository.Row(
            ("Size", (ulong)512_000_000_000),
            ("Enabled", (ushort)1),
            ("Count", "42"));

        Assert.Equal(512_000_000_000, record.GetInt64("Size"));
        Assert.Equal(1, record.GetInt32("Enabled"));
        Assert.Equal(42, record.GetInt32("Count"));
    }

    [Fact]
    public void GetInt32_ReturnsNullRatherThanTruncatingAValueThatDoesNotFit()
    {
        var record = FakeWmiRepository.Row(("Size", 512_000_000_000L));

        Assert.Null(record.GetInt32("Size"));
        Assert.Equal(512_000_000_000L, record.GetInt64("Size"));
    }

    [Fact]
    public void GetBytes_AcceptsTheBoxedArrayFormSomeProvidersReturn()
    {
        var record = FakeWmiRepository.Row(("VendorSpecific", new object[] { (byte)1, (byte)2, (byte)3 }));

        Assert.Equal(new byte[] { 1, 2, 3 }, record.GetBytes("VendorSpecific"));
    }

    [Fact]
    public void GetStringArray_NormalisesTheSeveralShapesOfAMultiValuedProperty()
    {
        var many = FakeWmiRepository.Row(("DNSServerSearchOrder", new[] { "10.0.0.1", " 10.0.0.2 ", "" }));
        var one = FakeWmiRepository.Row(("DNSServerSearchOrder", "10.0.0.1"));
        var none = FakeWmiRepository.Row(("DNSServerSearchOrder", null));

        Assert.Equal(new[] { "10.0.0.1", "10.0.0.2" }, many.GetStringArray("DNSServerSearchOrder"));
        Assert.Equal(new[] { "10.0.0.1" }, one.GetStringArray("DNSServerSearchOrder"));
        Assert.Empty(none.GetStringArray("DNSServerSearchOrder"));
    }

    [Fact]
    public void GetString_TreatsAnEmptyValueAsAbsent()
    {
        var record = FakeWmiRepository.Row(("SerialNumber", "   "));

        Assert.Null(record.GetString("SerialNumber"));
    }
}
