using System.Text;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

/// <summary>The parsing behind system.hardware, system.identity and network.hosts, including hostile input.</summary>
public class HardwareRulesTests
{
    [Fact]
    public void Hosts_keeps_addresses_and_names_and_drops_comments_and_blank_lines()
    {
        const string text = "# Copyright\r\n\r\n127.0.0.1       localhost\r\n::1 localhost ip6-localhost  # loopback\r\n   10.21.4.99\tsync.clinic.example   sync # stale\r\n#10.0.0.1 commented\r\n";
        var (entries, truncated) = HardwareRules.ParseHosts(text);
        Assert.False(truncated);
        Assert.Equal(3, entries.Count);
        Assert.Equal("127.0.0.1", entries[0].Address);
        Assert.Equal(["localhost"], entries[0].Names);
        Assert.Equal(["localhost", "ip6-localhost"], entries[1].Names);
        Assert.Equal("10.21.4.99", entries[2].Address);
        Assert.Equal(["sync.clinic.example", "sync"], entries[2].Names);
    }

    [Theory]
    [InlineData("")]
    [InlineData("\n\n\n")]
    [InlineData("# only a comment")]
    [InlineData("10.0.0.1")]                       // address with no name
    [InlineData("10.0.0.1 # name is in the comment")]
    [InlineData("not-an-address host")]
    [InlineData("999.1.1.1 host")]
    [InlineData("; rm -rf / host")]
    [InlineData("10.0.0.1/24 host")]
    [InlineData("0x7f000001 host")]                // not a plain address
    public void Hosts_drops_lines_that_are_not_entries(string text) => Assert.Empty(HardwareRules.ParseHosts(text).Entries);

    [Fact]
    public void Hosts_is_bounded_in_entries_names_and_line_length()
    {
        var many = string.Join('\n', Enumerable.Range(0, 800).Select(i => $"10.0.{i / 250}.{i % 250 + 1} host{i}"));
        var (entries, truncated) = HardwareRules.ParseHosts(many);
        Assert.Equal(HardwareRules.MaxHostsEntries, entries.Count);
        Assert.True(truncated);

        var names = string.Join(' ', Enumerable.Range(0, 100).Select(i => $"n{i}"));
        Assert.Equal(HardwareRules.MaxNamesPerEntry, HardwareRules.ParseHosts($"10.0.0.1 {names}").Entries[0].Names.Count);

        Assert.Empty(HardwareRules.ParseHosts("10.0.0.1 " + new string('a', 9000)).Entries);
        Assert.Empty(HardwareRules.ParseHosts("10.0.0.1 " + new string('a', 256)).Entries);
        Assert.Single(HardwareRules.ParseHosts("10.0.0.1 " + new string('a', 255)).Entries);
    }

    [Fact]
    public void Hosts_names_never_carry_control_characters_and_the_output_fits_the_contract()
    {
        var (entries, _) = HardwareRules.ParseHosts("10.0.0.1 bad\u0001name good\u0000 fine\n10.0.0.2 ok");
        Assert.Equal(["fine"], entries[0].Names);
        Assert.Equal(["ok"], entries[1].Names);
    }

    [Fact]
    public void Hosts_accepts_ipv6_with_a_scope_and_a_byte_order_mark()
    {
        byte[] bytes = [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes("fe80::1%12 router\n")];
        var (entries, _) = HardwareRules.ParseHosts(HardwareRules.DecodeHosts(bytes));
        Assert.Equal("fe80::1%12", Assert.Single(entries).Address);
        Assert.Empty(HardwareRules.ParseHosts(HardwareRules.DecodeHosts([0xFF, 0xFE, 0x00, 0x80, 0x81])).Entries);
    }

    private static byte[] Edid(string name, int width, int height, bool badSum = false)
    {
        var e = new byte[128];
        e[1] = e[2] = e[3] = e[4] = e[5] = e[6] = 0xFF;
        e[54] = 0x01; e[55] = 0x01;                                  // pixel clock
        e[56] = (byte)(width & 0xFF); e[58] = (byte)((width >> 8) << 4);
        e[59] = (byte)(height & 0xFF); e[61] = (byte)((height >> 8) << 4);
        int at = 72;
        e[at + 3] = 0xFC;
        var text = Encoding.ASCII.GetBytes(name + "\n");
        Array.Copy(text, 0, e, at + 5, Math.Min(13, text.Length));
        int sum = 0;
        for (int i = 0; i < 127; i++) sum += e[i];
        e[127] = (byte)((256 - sum % 256) % 256);
        if (badSum) e[127]++;
        return e;
    }

    [Fact]
    public void Edid_gives_the_name_and_native_resolution()
    {
        Assert.Equal(("DELL P2422H", 1920L, 1080L), HardwareRules.ParseEdid(Edid("DELL P2422H", 1920, 1080)));
        Assert.Equal(("Small", 1024L, 768L), HardwareRules.ParseEdid(Edid("Small", 1024, 768)));
    }

    [Fact]
    public void Edid_that_is_wrong_gives_nothing()
    {
        Assert.Equal((null, null, null), HardwareRules.ParseEdid(null));
        Assert.Equal((null, null, null), HardwareRules.ParseEdid([1, 2, 3]));
        Assert.Equal((null, null, null), HardwareRules.ParseEdid(new byte[128]));
        Assert.Equal((null, null, null), HardwareRules.ParseEdid(Edid("X", 1920, 1080, badSum: true)));
        Assert.Equal((null, null, null), HardwareRules.ParseEdid(Enumerable.Repeat((byte)0xFF, 4096).ToArray()));
        var noName = HardwareRules.ParseEdid(Edid("", 800, 600));
        Assert.Null(noName.Name);
    }

    [Fact]
    public void Secure_boot_follows_the_key_and_value()
    {
        Assert.Equal(SecureBootState.Unsupported, HardwareRules.SecureBootFor(false, null));
        Assert.Equal(SecureBootState.On, HardwareRules.SecureBootFor(true, 1));
        Assert.Equal(SecureBootState.Off, HardwareRules.SecureBootFor(true, 0));
        Assert.Null(HardwareRules.SecureBootFor(true, null));
        Assert.Null(HardwareRules.SecureBootFor(true, "on"));
        Assert.Null(HardwareRules.SecureBootFor(true, 7));
    }

    [Theory]
    [InlineData("2.0, 0, 1.38", "2.0")]
    [InlineData("1.2, 2, 3", "1.2")]
    [InlineData("2.0", "2.0")]
    [InlineData("", null)]
    [InlineData(null, null)]
    [InlineData("v2; drop table", null)]
    [InlineData("123456789.0", null)]
    public void Tpm_version(string? spec, string? expected) => Assert.Equal(expected, HardwareRules.TpmVersion(spec));

    [Fact]
    public void File_time_halves_become_a_time_and_nonsense_becomes_null()
    {
        var expected = new DateTimeOffset(2026, 10, 14, 11, 2, 40, TimeSpan.Zero);
        long ticks = expected.ToFileTime();
        Assert.Equal(expected, HardwareRules.FileTimeFromParts(unchecked((int)(uint)(ticks & 0xFFFFFFFF)), (int)(ticks >> 32)));
        Assert.Null(HardwareRules.FileTimeFromParts(0, 0));
        Assert.Null(HardwareRules.FileTimeFromParts(null, 5));
        Assert.Null(HardwareRules.FileTimeFromParts("1", "2"));
        Assert.Null(HardwareRules.FileTimeFromParts(-1, int.MaxValue));          // far beyond 2100
        Assert.Null(HardwareRules.FileTimeFromParts(1, 1));                      // 1601
    }

    [Theory]
    [InlineData(3, JoinType.Domain)] [InlineData(2, JoinType.Workgroup)] [InlineData(1, JoinType.Unknown)] [InlineData(0, JoinType.Unknown)] [InlineData(-4, JoinType.Unknown)]
    public void Join_type(int status, JoinType expected) => Assert.Equal(expected, HardwareRules.JoinTypeFor(status));

    [Fact]
    public void Auto_logon_flag_is_one_as_text_or_number_only()
    {
        Assert.True(HardwareRules.AutoLogonOn("1"));
        Assert.True(HardwareRules.AutoLogonOn(" 1 "));
        Assert.True(HardwareRules.AutoLogonOn(1));
        Assert.False(HardwareRules.AutoLogonOn("0"));
        Assert.False(HardwareRules.AutoLogonOn("true"));
        Assert.False(HardwareRules.AutoLogonOn(null));
        Assert.False(HardwareRules.AutoLogonOn(new byte[] { 1 }));
    }

    [Theory]
    [InlineData("COM1", true)] [InlineData("com12", true)] [InlineData("COM256", true)]
    [InlineData("COM0", false)] [InlineData("COM", false)] [InlineData("COM1234", false)] [InlineData("LPT1", false)] [InlineData("COM1;x", false)] [InlineData("\\\\.\\COM1", false)] [InlineData(null, false)]
    public void Com_port_names(string? name, bool expected) => Assert.Equal(expected, HardwareRules.IsComPortName(name));

    [Fact]
    public void Driver_key_must_be_the_ports_class_and_digits()
    {
        const string guid = "{4d36e978-e325-11ce-bfc1-08002be10318}";
        Assert.Equal("0003", HardwareRules.DriverKeyFor(guid + "\\0003", guid));
        Assert.Null(HardwareRules.DriverKeyFor(guid + "\\..\\x", guid));
        Assert.Null(HardwareRules.DriverKeyFor(guid + "\\00\\3", guid));
        Assert.Null(HardwareRules.DriverKeyFor("{other}\\0003", guid));
        Assert.Null(HardwareRules.DriverKeyFor(null, guid));
    }

    [Theory]
    [InlineData("@msports.inf,%portdesc%;Communications Port", "Communications Port")]
    [InlineData("USB Serial Port", "USB Serial Port")]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void Device_text(string? text, string? expected) => Assert.Equal(expected, HardwareRules.DeviceText(text));

    [Theory]
    [InlineData("DISPLAY\\DELA0A8\\5&1a2b3c&0&UID4352_0", "DISPLAY\\DELA0A8\\5&1a2b3c&0&UID4352")]
    [InlineData("DISPLAY\\DELA0A8\\4&2&0&UID0_12", "DISPLAY\\DELA0A8\\4&2&0&UID0")]
    [InlineData("DISPLAY\\..\\..\\Services", null)]
    [InlineData("DISPLAY\\A\\B\\C", null)]
    [InlineData("USB\\VID_1234\\5", null)]
    [InlineData("DISPLAY\\DELA0A8\\x y", null)]
    [InlineData(null, null)]
    public void Monitor_registry_path(string? instance, string? expected) => Assert.Equal(expected, HardwareRules.MonitorEnumPath(instance));

    [Fact]
    public void Numbers_become_text_up_to_the_first_zero()
    {
        Assert.Equal("DELL", HardwareRules.TextFromNumbers(new ushort[] { 68, 69, 76, 76, 0, 0, 88 }));
        Assert.Null(HardwareRules.TextFromNumbers(new ushort[] { 0, 0 }));
        Assert.Null(HardwareRules.TextFromNumbers("DELL"));
        Assert.True(HardwareRules.TextFromNumbers(Enumerable.Repeat((ushort)65, 500).ToArray())!.Length <= 64);
    }
}
