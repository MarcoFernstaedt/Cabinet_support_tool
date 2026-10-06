using System.Net;
using System.Net.Sockets;
using Cabinet.Agent.Core.Helpers;
using static Cabinet.Agent.Core.Tests.Fixtures;

namespace Cabinet.Agent.Core.Tests;

public sealed class EventQueryBuilderTests
{
    [Fact]
    public void No_filters_reads_everything() =>
        Assert.Equal("*", EventQueryBuilder.Build(new EventlogQueryParams { Log = "System" }).Filter);

    [Fact]
    public void All_filters_compose_into_one_expression()
    {
        var q = EventQueryBuilder.Build(new EventlogQueryParams
        {
            Log = "System", Levels = [EventLevel.Error, EventLevel.Critical, EventLevel.Information], Source = "disk",
            EventIds = [51, 7, 7], From = Start, To = Start.AddHours(1), BeforeRecordId = 1000,
        });
        Assert.Equal("*[System[(Level=0 or Level=1 or Level=2 or Level=4) and Provider[@Name='disk'] and (EventID=7 or EventID=51) and " +
                     "TimeCreated[@SystemTime>='2026-10-06T12:00:00.0000000Z'] and TimeCreated[@SystemTime<='2026-10-06T13:00:00.0000000Z'] and " +
                     "EventRecordID<1000]]", q.Filter);
        Assert.Null(q.SourceInCode);
    }

    [Theory]
    [InlineData("O'Brien Driver", "Provider[@Name=\"O'Brien Driver\"]")]
    [InlineData("say \"hi\"", "Provider[@Name='say \"hi\"']")]
    public void A_source_with_one_kind_of_quote_uses_the_other(string source, string clause) =>
        Assert.Contains(clause, EventQueryBuilder.Build(new EventlogQueryParams { Log = "System", Source = source }).Filter);

    [Fact]
    public void A_source_with_both_quotes_cannot_break_out_and_is_matched_in_code()
    {
        string hostile = "x'] or 1=1 or [\"";
        var q = EventQueryBuilder.Build(new EventlogQueryParams { Log = "System", Source = hostile });
        Assert.Equal("*", q.Filter);
        Assert.Equal(hostile, q.SourceInCode);
    }

    [Theory]
    [InlineData((byte)1, EventLevel.Critical)]
    [InlineData((byte)2, EventLevel.Error)]
    [InlineData((byte)3, EventLevel.Warning)]
    [InlineData((byte)4, EventLevel.Information)]
    [InlineData((byte)0, EventLevel.Information)]
    [InlineData((byte)5, EventLevel.Verbose)]
    [InlineData((byte)200, EventLevel.Information)]
    public void Windows_levels_map_to_contract_levels(byte windows, EventLevel level) =>
        Assert.Equal(level, EventLevels.FromWindows(windows));

    [Fact]
    public void Event_text_is_single_line_capped_and_free_of_control_characters()
    {
        Assert.Equal("first", EventText.FirstLine("first\r\nsecond"));
        Assert.Equal("a b", EventText.ShortText("a\u0007b"));
        Assert.Equal(256, EventText.FirstLine(new string('x', 1000)).Length);
        string emoji = new string('x', 255) + "\U0001F600";
        Assert.Equal(255, EventText.ShortText(emoji).Length); // never splits a surrogate pair
        Assert.Equal("a\nb", EventText.LongText("a\nb\u0000", 100));
    }
}

public sealed class FilesListingTests
{
    [Theory]
    [InlineData("C:\\", "C:\\")]
    [InlineData("c:\\ProgramData\\", "C:\\ProgramData")]
    [InlineData("C:\\Program Files\\Mashura", "C:\\Program Files\\Mashura")]
    public void Paths_are_canonical(string input, string expected) => Assert.Equal(expected, FilesListing.Canonical(input));

    [Theory]
    [InlineData("C:\\CON")]
    [InlineData("C:\\temp\\nul.txt")]
    [InlineData("C:\\Windows.")]
    [InlineData("C:\\Windows \\x")]
    [InlineData("C:\\\\Windows")]
    [InlineData("C:\\a\\..\\b")]
    [InlineData("D:\\")]
    [InlineData("C:")]
    [InlineData("C:\\com1\\x")]
    public void Device_names_and_names_Windows_would_rewrite_are_refused(string input) => Assert.Null(FilesListing.Canonical(input));

    [Fact]
    public void Every_ancestor_is_listed_for_the_reparse_point_check() =>
        Assert.Equal(new[] { "C:\\", "C:\\ProgramData", "C:\\ProgramData\\Mashura" }, FilesListing.SelfAndAncestors("C:\\ProgramData\\Mashura"));

    [Fact]
    public void Paging_puts_directories_first_and_reports_more()
    {
        var entries = new[] { "b.txt", "a.txt", "c.txt" }.Select(n => new FileEntry { Name = n, Type = FileEntryType.File, SizeBytes = 1, ModifiedAt = null })
            .Append(new FileEntry { Name = "zdir", Type = FileEntryType.Directory, SizeBytes = null, ModifiedAt = null }).ToList();
        var (page1, more1) = FilesListing.Page(entries, 1, 2);
        Assert.Equal(new[] { "zdir", "a.txt" }, page1.Select(e => e.Name));
        Assert.True(more1);
        var (page2, more2) = FilesListing.Page(entries, 2, 2);
        Assert.Equal(new[] { "b.txt", "c.txt" }, page2.Select(e => e.Name));
        Assert.False(more2);
        Assert.Empty(FilesListing.Page(entries, 100_000, 500).Entries);
    }
}

public sealed class DnsWireTests
{
    private static byte[] Reply(ushort id, int rcode, params byte[][] addresses)
    {
        var q = DnsWire.BuildQuery(id, "diag.mashura.example").ToList();
        q[2] = 0x81; q[3] = (byte)(0x80 | rcode);
        q[7] = (byte)addresses.Length;
        foreach (byte[] a in addresses) q.AddRange(new byte[] { 0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4 }.Concat(a));
        return q.ToArray();
    }

    [Fact]
    public void A_query_is_well_formed()
    {
        byte[] q = DnsWire.BuildQuery(0x1234, "diag.mashura.example");
        Assert.Equal(new byte[] { 0x12, 0x34, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, (byte)'d' }, q[..14]);
        Assert.Equal(new byte[] { 0, 0, 1, 0, 1 }, q[^5..]);
    }

    [Theory]
    [InlineData("")]
    [InlineData("bad_name.example")]
    [InlineData("a..b")]
    [InlineData("evil\0.example")]
    public void Bad_names_are_not_queried(string name) => Assert.Throws<ArgumentException>(() => DnsWire.BuildQuery(1, name));

    [Fact]
    public void Answers_are_parsed()
    {
        var answer = DnsWire.ParseResponse(Reply(7, 0, new byte[] { 10, 0, 0, 5 }, new byte[] { 10, 0, 0, 6 }), 7)!;
        Assert.Equal(0, answer.ResponseCode);
        Assert.Equal(new[] { IPAddress.Parse("10.0.0.5"), IPAddress.Parse("10.0.0.6") }, answer.Addresses);
        Assert.Equal(3, DnsWire.ParseResponse(Reply(7, 3), 7)!.ResponseCode);
    }

    [Fact]
    public void Hostile_and_mismatched_packets_are_refused()
    {
        byte[] good = Reply(7, 0, new byte[] { 10, 0, 0, 5 });
        Assert.Null(DnsWire.ParseResponse(good, 8));                 // wrong id
        Assert.Null(DnsWire.ParseResponse(good[..20], 7));           // truncated
        Assert.Null(DnsWire.ParseResponse(new byte[5], 7));          // too short
        byte[] query = DnsWire.BuildQuery(7, "a.example");
        Assert.Null(DnsWire.ParseResponse(query, 7));                // a query, not a response
        byte[] lying = (byte[])good.Clone(); lying[7] = 255;         // claims 255 answers
        Assert.Null(DnsWire.ParseResponse(lying, 7));
        byte[] longLength = (byte[])good.Clone(); longLength[^5] = 0xFF; // record length past the end
        Assert.Null(DnsWire.ParseResponse(longLength, 7));
        var labels = new List<byte>(good[..12]); labels[5] = 1;
        for (int i = 0; i < 200; i++) labels.AddRange(new byte[] { 1, (byte)'a' }); // never-ending name
        Assert.Null(DnsWire.ParseResponse(labels.ToArray(), 7));
        Assert.Null(DnsWire.ParseResponse(new byte[5000], 0));       // oversize
    }
}

public sealed class ServiceSidTests
{
    [Fact]
    public void The_service_sid_matches_the_value_windows_assigns() =>
        // Windows' published SID for NT SERVICE\TrustedInstaller.
        Assert.Equal("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", ServiceSid.For("TrustedInstaller"));

    [Fact]
    public void The_service_name_is_case_insensitive() =>
        Assert.Equal(ServiceSid.For("CabinetAgentNetwork"), ServiceSid.For("cabinetagentnetwork"));
}

public sealed class ScannerChecklistTests
{
    private const string Id = "USB\\VID_1234&PID_5678";

    private static DeviceFacts Scanner(bool present = true, long? problem = 0, bool driver = true, string? signer = "Microsoft Windows Hardware Compatibility Publisher") => new()
    {
        InstanceId = "USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2", Name = "Fingerprint Reader", Class = "Biometric", Present = present,
        Status = present ? "OK" : null, ProblemCode = problem, HardwareIds = [Id + "&REV_0100", Id], LocationInfo = "Port_#0002.Hub_#0003",
        Driver = driver ? new DriverFacts("oem42.inf", "3.1.0.7", Start, signer) : null,
    };

    private static PeripheralStatusOutput Run(IReadOnlyList<DeviceFacts> devices, string[]? ids = null, bool? suspend = false, int? starts = 1, string? service = "running")
    {
        var output = ScannerChecklist.Evaluate(new ScannerFacts
        {
            ConfiguredHardwareIds = ids ?? [Id], Devices = devices, SelectiveSuspendEnabled = suspend, StartsLast24Hours = starts, BiometricServiceState = service,
        });
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.PeripheralStatus), JsonSerializer.SerializeToElement(output, ContractJson.Options)));
        return output;
    }

    private static PeripheralCheckOutcome Outcome(PeripheralStatusOutput o, PeripheralCheckId id) => o.Checks.Single(c => c.Check == id).Outcome;

    [Fact]
    public void A_healthy_scanner_passes_every_check()
    {
        var o = Run([Scanner()]);
        Assert.True(o.Connected);
        Assert.Equal("Port_#0002.Hub_#0003", o.LocationInfo);
        Assert.All(o.Checks, c => Assert.Equal(PeripheralCheckOutcome.Pass, c.Outcome));
        Assert.Empty(o.Candidates);
    }

    [Fact]
    public void Without_configured_ids_likely_scanners_are_listed_as_candidates()
    {
        var other = new DeviceFacts { InstanceId = "USB\\VID_0001&PID_0002\\1", Name = "USB Keyboard", Class = "Keyboard", Present = true };
        var named = new DeviceFacts { InstanceId = "USB\\VID_9999&PID_0001\\1", Name = "ACME Finger Print Sensor", Class = "USB", Present = false };
        var o = Run([other, Scanner(), named], ids: []);
        Assert.False(o.Configured);
        Assert.Equal(PeripheralCheckOutcome.Unknown, Outcome(o, PeripheralCheckId.DevicePresent));
        Assert.Equal(new[] { "Fingerprint Reader", "ACME Finger Print Sensor" }, o.Candidates.Select(c => c.Name));
    }

    [Fact]
    public void A_configured_scanner_windows_never_saw_fails_and_suggests_another_port()
    {
        var o = Run([], ids: ["USB\\VID_AAAA&PID_BBBB"]);
        Assert.Equal(PeripheralCheckOutcome.Fail, Outcome(o, PeripheralCheckId.DevicePresent));
        Assert.Contains("different USB port", o.Checks[0].Summary);
    }

    [Fact]
    public void A_disconnected_scanner_fails_presence_and_skips_device_checks()
    {
        var o = Run([Scanner(present: false)]);
        Assert.False(o.Connected);
        Assert.Equal(PeripheralCheckOutcome.Fail, Outcome(o, PeripheralCheckId.DevicePresent));
        Assert.Equal(PeripheralCheckOutcome.Unknown, Outcome(o, PeripheralCheckId.NoDeviceError));
    }

    [Fact]
    public void A_connected_match_wins_over_a_remembered_one() =>
        Assert.True(Run([Scanner(present: false), Scanner()]).Connected);

    [Fact]
    public void Code_43_is_explained_with_what_to_try()
    {
        var o = Run([Scanner(problem: 43)]);
        Assert.Equal(43, o.ErrorCode);
        Assert.Equal(PeripheralCheckOutcome.Fail, Outcome(o, PeripheralCheckId.NoDeviceError));
        Assert.Contains("different USB port", o.ErrorText);
    }

    [Fact]
    public void Missing_or_unsigned_drivers_fail()
    {
        Assert.Equal(PeripheralCheckOutcome.Fail, Outcome(Run([Scanner(driver: false)]), PeripheralCheckId.DriverInstalled));
        Assert.Equal(PeripheralCheckOutcome.Fail, Outcome(Run([Scanner(signer: null)]), PeripheralCheckId.DriverSigned));
    }

    [Fact]
    public void Power_saving_and_repeated_reconnects_are_warnings()
    {
        Assert.Equal(PeripheralCheckOutcome.Warn, Outcome(Run([Scanner()], suspend: true), PeripheralCheckId.UsbPowerSaving));
        var o = Run([Scanner()], starts: 6);
        Assert.Equal(PeripheralCheckOutcome.Warn, Outcome(o, PeripheralCheckId.RecentReconnects));
        Assert.Contains("5 times", o.Checks.Single(c => c.Check == PeripheralCheckId.RecentReconnects).Summary);
        Assert.Equal(PeripheralCheckOutcome.Pass, Outcome(Run([Scanner()], starts: 3), PeripheralCheckId.RecentReconnects));
        Assert.Equal(PeripheralCheckOutcome.Unknown, Outcome(Run([Scanner()], starts: null, suspend: null), PeripheralCheckId.RecentReconnects));
    }

    [Fact]
    public void A_failing_usb_hub_and_a_stopped_biometric_service_are_reported()
    {
        var hub = new DeviceFacts { InstanceId = "USB\\ROOT_HUB30\\4&1", Name = "USB Root Hub (USB 3.0)", Class = "USB", Present = true, ProblemCode = 10 };
        var o = Run([Scanner(), hub], service: "stopped");
        Assert.Equal(PeripheralCheckOutcome.Fail, Outcome(o, PeripheralCheckId.UsbControllerErrors));
        Assert.Equal(PeripheralCheckOutcome.Warn, Outcome(o, PeripheralCheckId.BiometricService));
    }

    [Fact]
    public void Hardware_id_matching_ignores_case() =>
        Assert.True(Run([Scanner()], ids: ["usb\\vid_1234&pid_5678"]).Connected);

    [Fact]
    public void Every_problem_code_text_is_plain_and_bounded()
    {
        for (long code = 1; code < 60; code++)
        {
            string text = DeviceProblems.Describe(code)!;
            Assert.InRange(text.Length, 10, 256);
        }
        Assert.Null(DeviceProblems.Describe(0));
        Assert.Null(DeviceProblems.Describe(null));
    }
}

public sealed class NetworkTesterTests
{
    private static NetworkTester Tester(AgentConfig config, params AdapterFacts[] adapters) => new(config, () => adapters);
    private static readonly AdapterFacts Lan = new(true, [IPAddress.Parse("192.0.2.1")], [IPAddress.Parse("192.0.2.53"), IPAddress.Parse("192.0.2.54")]);
    private static readonly AdapterFacts Down = new(false, [IPAddress.Parse("198.51.100.1")], [IPAddress.Parse("198.51.100.53")]);

    private static void AssertValid(NetworkTestOutput o) =>
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.NetworkTest), JsonSerializer.SerializeToElement(o, ContractJson.Options)));

    [Fact]
    public async Task No_gateway_on_a_connected_adapter_is_a_clear_failed_test()
    {
        var o = await Tester(Config(), Down).RunAsync(new NetworkTestParams { Target = NetworkTestTarget.Gateway, Method = NetworkTestMethod.Ping }, default);
        Assert.False(o.Success);
        Assert.Contains("no default gateway", o.Error);
        AssertValid(o);
    }

    [Fact]
    public async Task A_dns_server_index_past_the_configured_servers_says_how_many_there_are()
    {
        var o = await Tester(Config(), Lan).RunAsync(new NetworkTestParams { Target = NetworkTestTarget.DnsServer, Method = NetworkTestMethod.Ping, DnsServerIndex = 3 }, default);
        Assert.False(o.Success);
        Assert.Contains("2 DNS server", o.Error);
        AssertValid(o);
    }

    [Fact]
    public async Task An_unconfigured_sync_cabinet_or_platform_server_is_unavailable()
    {
        var sync = await Assert.ThrowsAsync<OperationFailedException>(() => Tester(Config(), Lan).RunAsync(
            new NetworkTestParams { Target = NetworkTestTarget.SyncCabinet, Method = NetworkTestMethod.Ping }, default));
        Assert.Equal("unavailable", sync.Code);
        var dns = await Assert.ThrowsAsync<OperationFailedException>(() => Tester(Config(), Lan).RunAsync(
            new NetworkTestParams { Target = NetworkTestTarget.DnsServer, Method = NetworkTestMethod.Dns, DnsServerIndex = 0 }, default));
        Assert.Equal("unavailable", dns.Code);
    }

    [Fact]
    public async Task Tcp_connects_to_the_configured_sync_cabinet()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var o = await Tester(Config(sync: "127.0.0.1", ports: [port]), Lan).RunAsync(
            new NetworkTestParams { Target = NetworkTestTarget.SyncCabinet, Method = NetworkTestMethod.Tcp, Port = port }, default);
        Assert.True(o.Success, o.Error);
        Assert.Equal("127.0.0.1", o.ResolvedTarget);
        AssertValid(o);
        listener.Stop();

        var refused = await Tester(Config(sync: "127.0.0.1", ports: [port]), Lan).RunAsync(
            new NetworkTestParams { Target = NetworkTestTarget.SyncCabinet, Method = NetworkTestMethod.Tcp, Port = port }, default);
        Assert.False(refused.Success);
        Assert.Contains("refused", refused.Error);
        AssertValid(refused);
    }

    [Fact]
    public async Task A_name_that_does_not_resolve_is_a_failed_test_not_an_error()
    {
        var o = await Tester(Config(platform: "does-not-exist.invalid"), Lan).RunAsync(
            new NetworkTestParams { Target = NetworkTestTarget.PlatformServer, Method = NetworkTestMethod.Dns }, default);
        Assert.False(o.Success);
        AssertValid(o);
    }
}

public sealed class ConfigAndStoreTests
{
    private static string Valid() => File.ReadAllText(Path.Combine(ContractsDir(), "examples", "agent", "agent-config", "valid", "configured.json"));

    [Fact]
    public void A_valid_configuration_loads()
    {
        var config = AgentConfigLoader.Parse(Bytes(Valid()));
        Assert.True(config.ReadOnlyMode);
        Assert.Equal(["USB\\VID_1234&PID_5678"], config.Scanner.HardwareIds);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("not json")]
    [InlineData("")]
    public void An_invalid_configuration_stops_the_agent(string text) =>
        Assert.Throws<AgentConfigException>(() => AgentConfigLoader.Parse(Bytes(text)));

    [Fact]
    public void A_configuration_with_unknown_or_duplicate_settings_is_refused()
    {
        Assert.Throws<AgentConfigException>(() => AgentConfigLoader.Parse(Bytes(Valid().Replace("\"readOnlyMode\": true", "\"readOnlyMode\": true, \"shell\": \"cmd\""))));
        Assert.Throws<AgentConfigException>(() => AgentConfigLoader.Parse(Bytes(Valid().Replace("\"readOnlyMode\": true", "\"readOnlyMode\": true, \"readOnlyMode\": false"))));
        Assert.Throws<AgentConfigException>(() => AgentConfigLoader.Parse(new byte[AgentConfigLoader.MaxBytes + 1]));
    }

    [Fact]
    public void The_replay_store_ignores_tampered_lines_and_drops_expired_ones()
    {
        using var dir = new TempDir();
        var clock = new ManualClock(Start);
        Guid live = Guid.NewGuid(), old = Guid.NewGuid();
        File.WriteAllText(dir.File("replay"),
            $"{live:D} {Start.AddMinutes(5).ToUnixTimeSeconds()}\n{old:D} {Start.AddMinutes(-1).ToUnixTimeSeconds()}\ngarbage\n{Guid.NewGuid():D} 99999999999999999999\n{Guid.NewGuid():D} -5\n");
        var store = new ReplayStore(dir.File("replay"), clock);
        Assert.Equal(1, store.Count);
        Assert.Equal(ReplayStore.Outcome.AlreadySeen, store.TryRecord(live, Start.AddMinutes(5), Start));
        Assert.Equal(ReplayStore.Outcome.Recorded, store.TryRecord(old, Start.AddMinutes(5), Start));
    }

    [Fact]
    public void The_write_limit_cannot_be_reset_by_moving_the_clock_back()
    {
        using var dir = new TempDir();
        var clock = new ManualClock(Start);
        var limits = new RateLimiter(dir.File("writes"), clock);
        for (int i = 0; i < 20; i++) Assert.True(limits.TryTake(RateClass.Write, Start));
        clock.Now = Start.AddMinutes(-30);
        Assert.False(new RateLimiter(dir.File("writes"), clock).TryTake(RateClass.Write, clock.Now));
    }
}

public sealed class SmartDecoderTests
{
    private static byte[] Table(params (byte Id, long Raw)[] attributes)
    {
        var table = new byte[2 + 30 * 12];
        for (int i = 0; i < attributes.Length; i++)
        {
            int o = 2 + i * 12;
            table[o] = attributes[i].Id;
            for (int b = 0; b < 6; b++) table[o + 5 + b] = (byte)(attributes[i].Raw >> (8 * b));
        }
        return table;
    }

    [Fact]
    public void Attributes_decode_from_the_vendor_table()
    {
        var raw = SmartDecoder.RawValues(Table((5, 12), (9, 20_000), (194, 0x0000_2200_0029), (197, 1)));
        Assert.Equal(12, SmartDecoder.Value(raw, SmartDecoder.ReallocatedSectors));
        Assert.Equal(20_000, SmartDecoder.Value(raw, SmartDecoder.PowerOnHours));
        Assert.Equal(41, SmartDecoder.TemperatureCelsius(raw));
        Assert.Null(SmartDecoder.Value(raw, SmartDecoder.Uncorrectable));
    }

    [Fact]
    public void Short_empty_and_implausible_tables_do_not_throw()
    {
        Assert.Empty(SmartDecoder.RawValues(null));
        Assert.Empty(SmartDecoder.RawValues(new byte[7]));
        Assert.Null(SmartDecoder.TemperatureCelsius(SmartDecoder.RawValues(Table((194, 200)))));
        Assert.Single(SmartDecoder.RawValues(Table((5, 1), (5, 99))));
    }

    [Theory]
    [InlineData(0, false, 0L, 0L, DriveHealth.Healthy)]
    [InlineData(0, true, 0L, 0L, DriveHealth.Failing)]
    [InlineData(2, false, 0L, 0L, DriveHealth.Failing)]
    [InlineData(1, false, 0L, 0L, DriveHealth.Warning)]
    [InlineData(0, false, 3L, 0L, DriveHealth.Warning)]
    [InlineData(null, null, null, null, DriveHealth.Unknown)]
    public void Health_combines_windows_status_and_smart(int? status, bool? predict, long? realloc, long? pending, DriveHealth expected) =>
        Assert.Equal(expected, SmartDecoder.Health(status, predict, realloc, pending));
}
