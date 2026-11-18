using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Configuration;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Tests;

public class ConfigCanonicalTests
{
    [Fact]
    public void The_hash_matches_the_vectors_the_server_checks_too()
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Fixtures.ContractsDir(), "vectors", "config-hash-vectors.json")));
        int count = 0;
        foreach (JsonElement vector in doc.RootElement.GetProperty("vectors").EnumerateArray())
        {
            var items = vector.GetProperty("items").EnumerateArray().Select(i => new ConfigItem
            {
                Key = i.GetProperty("key").GetString()!,
                Values = i.GetProperty("values").EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone()),
            }).ToList();
            Assert.Equal(vector.GetProperty("hash").GetString(), ConfigCanonical.Hash(items));
            count++;
        }
        Assert.True(count >= 8, "the vectors include the hosts, tasks, system and escaping cases");
    }

    [Fact]
    public void The_order_of_items_and_values_never_changes_the_hash_but_a_value_does()
    {
        var a = new ConfigItem { Key = "service:a", Values = new Dictionary<string, object?> { ["state"] = "running", ["startType"] = "automatic" } };
        var b = new ConfigItem { Key = "service:b", Values = new Dictionary<string, object?> { ["list"] = new List<string> { "x", "y" } } };
        string one = ConfigCanonical.Hash([a, b]);
        Assert.Equal(one, ConfigCanonical.Hash([b, a with { Values = new Dictionary<string, object?> { ["startType"] = "automatic", ["state"] = "running" } }]));
        Assert.NotEqual(one, ConfigCanonical.Hash([a with { Values = new Dictionary<string, object?> { ["state"] = "stopped", ["startType"] = "automatic" } }, b]));
        // The order of a list is part of the configuration (DNS search order), so it is kept.
        Assert.NotEqual(ConfigCanonical.Hash([b]), ConfigCanonical.Hash([b with { Values = new Dictionary<string, object?> { ["list"] = new List<string> { "y", "x" } } }]));
    }

    [Fact]
    public void Quotes_backslashes_and_unicode_are_written_the_way_the_server_writes_them()
    {
        var item = new ConfigItem { Key = "app:Caf\u00e9 \"Pro\"", Values = new Dictionary<string, object?> { ["publisher"] = "Soci\u00e9t\u00e9 \\ \u00dc" } };
        Assert.Equal("[{\"key\":\"app:Caf\u00e9 \\\"Pro\\\"\",\"values\":{\"publisher\":\"Soci\u00e9t\u00e9 \\\\ \u00dc\"}}]", ConfigCanonical.Json([item]));
    }

    [Fact]
    public void A_value_that_is_not_text_a_whole_number_a_flag_nothing_or_a_list_of_texts_is_refused()
    {
        foreach (object bad in new object[] { 1.5, new object(), new Dictionary<string, object?>(), DateTime.UnixEpoch })
        {
            var item = new ConfigItem { Key = "x:y", Values = new Dictionary<string, object?> { ["v"] = bad } };
            Assert.Throws<ArgumentException>(() => ConfigCanonical.Json([item]));
        }
    }
}

public class ConfigBuilderTests
{
    private static NetworkAdapter Adapter(string name, string address = "10.21.4.25", bool dhcp = true, string[]? dns = null) => new()
    {
        InterfaceIndex = 12, Name = name, Description = null, Type = AdapterType.Ethernet, Connected = true, LinkSpeedBps = 1_000_000_000, MacAddress = "00-1B-21-13-4F-5C",
        Ipv4 = new Ipv4Settings { Dhcp = dhcp, Addresses = [new Ipv4Address { Address = address, PrefixLength = 24 }], Gateways = ["10.21.4.1"] },
        Ipv6Addresses = [], Dns = new DnsSettings { Automatic = dhcp, Servers = dns ?? ["10.21.4.10", "10.21.4.11"] }, DnsSuffix = "clinic.example",
        Details = new AdapterDetails
        {
            DhcpServer = "10.21.4.2", LeaseObtained = Fixtures.Start, LeaseExpires = Fixtures.Start.AddHours(8), Mtu = 1500, Statistics = null, InterfaceMetric = 25,
            Driver = new AdapterDriver { Provider = "Intel", Version = "12.19.1.37", Date = Fixtures.Start },
        },
    };

    private static ConfigSnapshotCategory Network(NetworkAdapter a, IReadOnlyList<RouteEntry>? routes = null) => ConfigBuilders.Network(new NetworkConfigOutput { Adapters = [a], Routes = routes });

    [Fact]
    public void A_network_snapshot_has_adapters_dhcp_dns_and_the_routes_somebody_configured_not_the_noise()
    {
        var routes = new List<RouteEntry>
        {
            new() { Destination = "0.0.0.0", PrefixLength = 0, NextHop = "10.21.4.1", Metric = 25, InterfaceIndex = 12 },
            new() { Destination = "10.21.4.0", PrefixLength = 24, NextHop = "0.0.0.0", Metric = 281, InterfaceIndex = 12 },
            new() { Destination = "10.21.4.25", PrefixLength = 32, NextHop = "0.0.0.0", Metric = 281, InterfaceIndex = 12 },
            new() { Destination = "127.0.0.0", PrefixLength = 8, NextHop = "0.0.0.0", Metric = 331, InterfaceIndex = 1 },
            new() { Destination = "224.0.0.0", PrefixLength = 4, NextHop = "0.0.0.0", Metric = 281, InterfaceIndex = 12 },
            new() { Destination = "255.255.255.255", PrefixLength = 32, NextHop = "0.0.0.0", Metric = 281, InterfaceIndex = 12 },
        };
        var c = Network(Adapter("Ethernet"), routes);
        Assert.Equal(["adapter:Ethernet", "route:0.0.0.0/0 via 10.21.4.1", "route:10.21.4.0/24 via 0.0.0.0"], c.Items.Select(i => i.Key));
        var adapter = c.Items[0].Values;
        Assert.Equal(true, adapter["dhcp"]);
        Assert.Equal("10.21.4.2", adapter["dhcpServer"]);
        Assert.Equal(1000, adapter["linkSpeedMbps"]);
        Assert.Equal(25, adapter["metric"]);
        Assert.Equal(["10.21.4.25/24"], (List<string>)adapter["addresses"]!);
        Assert.Equal(["10.21.4.10", "10.21.4.11"], (List<string>)adapter["dnsServers"]!);
        Assert.Equal(64, c.Hash.Length);
    }

    [Fact]
    public void The_lease_times_and_counters_that_move_by_themselves_do_not_change_the_hash_but_a_dns_server_does()
    {
        var a = Adapter("Ethernet");
        var later = a with { Details = a.Details! with { LeaseObtained = Fixtures.Start.AddHours(3), LeaseExpires = Fixtures.Start.AddHours(11), Statistics = new AdapterStatistics
            { BytesReceived = 9, BytesSent = 9, ReceiveErrors = 9, SendErrors = 9, ReceiveDiscards = 9, SendDiscards = 9 } } };
        Assert.Equal(Network(a).Hash, Network(later).Hash);
        Assert.NotEqual(Network(a).Hash, Network(Adapter("Ethernet", dns: ["8.8.8.8"])).Hash);
    }

    [Fact]
    public void A_service_that_is_only_starting_is_not_a_change_and_nothing_that_changes_by_itself_is_included()
    {
        ServiceInfo Svc(ServiceState s, long pid) => new()
        {
            Name = "BioScanSvc", DisplayName = "Biometric", State = s, StartType = ServiceStartType.Automatic, Account = "LocalSystem", ProcessId = pid, ExecutablePath = "C:\\x.exe", Description = null, Recovery = null,
        };
        string Hash(ServiceInfo s) => ConfigBuilders.Services(new ServicesListOutput { Services = [s], Watched = [] }).Hash;
        Assert.Equal(Hash(Svc(ServiceState.Running, 100)), Hash(Svc(ServiceState.StartPending, 200)));
        Assert.NotEqual(Hash(Svc(ServiceState.Running, 100)), Hash(Svc(ServiceState.Stopped, 100)));
        var disabled = Svc(ServiceState.Running, 100) with { StartType = ServiceStartType.Disabled };
        Assert.NotEqual(Hash(Svc(ServiceState.Running, 100)), Hash(disabled));
    }

    [Fact]
    public void Time_ignores_the_clock_and_the_last_sync_and_notices_a_zone_change()
    {
        TimeStatusOutput T(string zone, DateTimeOffset now, DateTimeOffset? sync) => new()
        {
            TimeZoneId = zone, TimeZoneName = zone, UtcOffsetMinutes = -300, DaylightSavingNow = false, LocalTime = "x", UtcTime = now,
            TimeService = TimeServiceState.Running, Sync = new TimeSync { State = TimeSyncState.Synced, Source = "time.windows.com", LastSuccessfulSync = sync }, PolicyManaged = false,
        };
        var a = ConfigBuilders.Time(T("Eastern Standard Time", Fixtures.Start, Fixtures.Start)).Hash;
        Assert.Equal(a, ConfigBuilders.Time(T("Eastern Standard Time", Fixtures.Start.AddHours(3), Fixtures.Start.AddHours(2))).Hash);
        Assert.NotEqual(a, ConfigBuilders.Time(T("Central Standard Time", Fixtures.Start, Fixtures.Start)).Hash);
    }

    [Fact]
    public void Duplicate_names_get_distinct_keys_hostile_names_are_cleaned_and_a_huge_list_is_cut_and_says_so()
    {
        var firewall = new FirewallStateOutput
        {
            Profiles = [], RulesTruncated = false, Snapshots = [],
            Rules = Enumerable.Range(0, 2).Select(_ => new ReportedFirewallRule { Name = "Allow <b>Sync</b>\u0007", Direction = FirewallDirection.In, Action = FirewallAction.Allow, Enabled = true, CreatedByPlatform = false }).ToList(),
        };
        var c = ConfigBuilders.Firewall(firewall);
        Assert.Equal(["rule:Allow  b Sync /b", "rule:Allow  b Sync /b#2"], c.Items.Select(i => i.Key).ToList());
        var many = ConfigBuilders.Applications(new SoftwareListOutput { TakenAt = Fixtures.Start, Hotfixes = [], Truncated = false,
            Programs = Enumerable.Range(0, 2500).Select(i => new InstalledProgram { Name = $"App {i:0000}", Version = "1.0", Publisher = null, InstalledOn = null }).ToList() });
        Assert.Equal(ConfigBuilders.MaxItems, many.Items.Count);
        Assert.True(many.Truncated);
        // The same application in both Uninstall lists is one item, at its higher version.
        var one = ConfigBuilders.Applications(new SoftwareListOutput { TakenAt = Fixtures.Start, Hotfixes = [], Truncated = false, Programs = [
            new InstalledProgram { Name = "Tool", Version = "1.0", Publisher = "A", InstalledOn = null }, new InstalledProgram { Name = "Tool", Version = "2.0", Publisher = "A", InstalledOn = null }] });
        Assert.Equal("2.0", one.Items.Single().Values["version"]);
    }

    [Fact]
    public void A_category_over_its_size_budget_is_cut_at_whole_items_and_says_so_and_the_hash_describes_what_is_kept()
    {
        var big = ConfigBuilders.Make(ConfigCategory.Applications, Enumerable.Range(0, 1500).Select(i => (ConfigItem?)new ConfigItem
        {
            Key = $"app:Application number {i:0000}", Values = new Dictionary<string, object?> { ["version"] = new string('9', 190), ["publisher"] = new string('P', 190) },
        }));
        Assert.True(big.Truncated);
        Assert.InRange(ConfigBuilders.Size(big), 1, ConfigBuilders.MaxCategoryBytes);
        Assert.True(big.Items.Count < 1500 && big.Items.Count > 100);
        Assert.Equal(ConfigCanonical.Hash(big.Items), big.Hash);
        // Cut again to fit a whole snapshot in one request: still consistent.
        var cut = ConfigBuilders.Cut(big, 10);
        Assert.Equal(10, cut.Items.Count);
        Assert.True(cut.Truncated);
        Assert.Equal(ConfigCanonical.Hash(cut.Items), cut.Hash);
    }

    [Fact]
    public void Several_large_categories_are_trimmed_largest_first_until_the_snapshot_fits_in_one_request()
    {
        ConfigSnapshotCategory Big(ConfigCategory c, int n) => ConfigBuilders.Make(c, Enumerable.Range(0, n).Select(i => (ConfigItem?)new ConfigItem
        {
            Key = $"{(c == ConfigCategory.Applications ? "app" : c == ConfigCategory.Devices ? "device" : c == ConfigCategory.Tasks ? "task" : "driver")}:item {i:0000}", Values = new Dictionary<string, object?> { ["a"] = new string('x', 180), ["b"] = new string('y', 180) },
        }));
        var fitted = ConfigCollector.Fit([Big(ConfigCategory.Applications, 1000), Big(ConfigCategory.Devices, 1000), Big(ConfigCategory.Drivers, 1000), Big(ConfigCategory.Tasks, 1000), ConfigBuilders.Time(
            new TimeStatusOutput { TimeZoneId = "Eastern Standard Time", TimeZoneName = "x", UtcOffsetMinutes = 0, DaylightSavingNow = false, LocalTime = "x", UtcTime = Fixtures.Start,
                TimeService = TimeServiceState.Running, Sync = new TimeSync { State = TimeSyncState.Synced, Source = null, LastSuccessfulSync = null }, PolicyManaged = false })]);
        Assert.True(fitted.Sum(ConfigBuilders.Size) <= ConfigBuilders.MaxSnapshotBytes);
        Assert.Contains(fitted, c => c.Truncated);
        Assert.False(fitted.Single(c => c.Category == ConfigCategory.Time).Truncated, "a small category is never cut for a large one");
        foreach (var c in fitted) Assert.Equal(ConfigCanonical.Hash(c.Items), c.Hash);
    }

    [Fact]
    public void A_lone_surrogate_would_hash_differently_in_javascript_so_it_never_leaves_the_builders()
    {
        var c = ConfigBuilders.Services(new ServicesListOutput { Watched = [], Services = [new ServiceInfo { Name = "Svc\ud800x", DisplayName = "d", State = ServiceState.Running, StartType = ServiceStartType.Automatic,
            Account = "Acc\udc00", ProcessId = null, ExecutablePath = "C:\\a\\b.exe", Description = null, Recovery = null }] });
        Assert.Equal("service:Svc\ufffdx", c.Items.Single().Key);
        Assert.Equal("Acc\ufffd", c.Items.Single().Values["account"]);
        // A real pair (an emoji) is kept as it is.
        Assert.Equal("Caf\ud83d\ude00", ConfigBuilders.Text("Caf\ud83d\ude00"));
    }

    [Fact]
    public void A_startup_entry_keeps_its_program_and_never_its_arguments_and_the_hosts_file_only_its_addresses_and_names()
    {
        Assert.Equal("C:\\Program Files\\Bio Scan\\scan.exe", ConfigBuilders.ProgramOf("\"C:\\Program Files\\Bio Scan\\scan.exe\" --password=hunter2 --user admin"));
        Assert.Equal("C:\\Tools\\sync.exe", ConfigBuilders.ProgramOf("C:\\Tools\\sync.exe /key=abc123"));
        Assert.Equal("cmd", ConfigBuilders.ProgramOf("cmd /c secret.bat"));
        Assert.Equal("C:\\x", ConfigBuilders.ProgramOf("\"C:\\x"));
        var tasks = ConfigBuilders.Tasks(new StartupListOutput
        {
            TakenAt = Fixtures.Start, Truncated = false,
            Startup = [new StartupItem { Name = "BioScan", Command = "\"C:\\Program Files\\BioScan\\scan.exe\" --token=SECRET", Location = "HKLM Run" }],
            Tasks = [new ScheduledTaskInfo { Path = "\\ExampleOperator\\", Name = "Nightly check", State = TaskState.Ready, LastRun = Fixtures.Start, LastResult = 0, NextRun = Fixtures.Start.AddDays(1) }],
        });
        Assert.DoesNotContain("SECRET", ConfigCanonical.Json(tasks.Items));
        Assert.Equal(["startup:HKLM Run/BioScan", "task:\\ExampleOperator\\Nightly check"], tasks.Items.Select(i => i.Key));
        // A task's last run, result and next run move by themselves: only its state is part of the configuration.
        Assert.Equal(["state"], tasks.Items.Single(i => i.Key.StartsWith("task:")).Values.Keys);
        var hosts = ConfigBuilders.Hosts(new NetworkHostsOutput
        {
            TakenAt = Fixtures.Start, Truncated = false,
            Entries = [new HostsEntry { Address = "127.0.0.1", Names = ["localhost"] }, new HostsEntry { Address = "10.21.4.20", Names = ["sync", "pharmacy-sync"] }, new HostsEntry { Address = "10.21.4.20", Names = ["sync", "alias"] }],
        });
        Assert.Equal(["host:10.21.4.20", "host:127.0.0.1"], hosts.Items.Select(i => i.Key));
        Assert.Equal(["alias", "pharmacy-sync", "sync"], (List<string>)hosts.Items[0].Values["names"]!);
    }

    [Fact]
    public void Hardware_and_identity_make_one_machine_description_and_the_cabinets_own_name_is_not_part_of_an_account()
    {
        var hardware = new SystemHardwareOutput
        {
            TakenAt = Fixtures.Start, Manufacturer = "Dell Inc.", Model = "OptiPlex 7090", Bios = new BiosInfo { Vendor = "Dell Inc.", Version = "1.18.0", Date = Fixtures.Start },
            Cpu = new CpuInfo { Model = "Intel(R) Core(TM) i5", LogicalCores = 12 }, Memory = new MemoryInfo { TotalBytes = 16L * 1024 * 1024 * 1024, ModuleCount = 2, Modules = [] },
            Tpm = new TpmInfo { Present = true, Enabled = true, Version = "2.0" }, SecureBoot = SecureBootState.On, LastBoot = Fixtures.Start, Monitors = [], Ports = [],
        };
        SystemIdentityOutput Identity(string host, params string[] admins) => new()
        {
            TakenAt = Fixtures.Start, JoinType = JoinType.Domain, Name = "clinic.example", DomainControllerFound = true, GroupPolicyLastApplied = Fixtures.Start,
            LocalAdministrators = new LocalAdministrators { Names = admins.Select(a => a.Replace("{host}", host)).ToList(), Truncated = false }, AutoLogon = new AutoLogonInfo { Enabled = false, UserName = null },
        };
        var one = ConfigBuilders.Machine(hardware, Identity("CAB-01S01", "{host}\\Administrator", "CLINIC\\Domain Admins"), "CAB-01S01");
        var other = ConfigBuilders.Machine(hardware, Identity("CAB-02C03", "{host}\\Administrator", "CLINIC\\Domain Admins"), "CAB-02C03");
        Assert.Equal(one.Hash, other.Hash);
        Assert.Equal(["hardware", "identity"], one.Items.Select(i => i.Key));
        Assert.Equal("OptiPlex 7090", one.Items[0].Values["model"]);
        Assert.Equal(16384, one.Items[0].Values["memoryMb"]);
        Assert.Equal([".\\Administrator", "CLINIC\\Domain Admins"], (List<string>)one.Items[1].Values["localAdministrators"]!);
        var extra = ConfigBuilders.Machine(hardware, Identity("CAB-01S01", "{host}\\Administrator", "CLINIC\\Domain Admins", "CLINIC\\temp.install"), "CAB-01S01");
        Assert.NotEqual(one.Hash, extra.Hash);
    }

    [Fact]
    public void Duplicate_firewall_names_at_the_key_limit_still_form_a_valid_upload()
    {
        // A real Windows resource-name exceeded the limit; numbering its duplicate used to exceed it again.
        string longName = "SyntheticResource_" + new string('x', 200);
        var state = new FirewallStateOutput
        {
            Rules = Enumerable.Range(0, 2).Select(_ => new ReportedFirewallRule
            {
                Name = longName, Direction = FirewallDirection.In, Action = FirewallAction.Allow,
                Enabled = true, CreatedByPlatform = false,
            }).ToList(),
            RulesTruncated = false, Snapshots = [], Profiles = [],
        };
        var category = ConfigBuilders.Firewall(state);
        Assert.Equal(2, category.Items.Count);
        Assert.Equal(2, category.Items.Select(i => i.Key).Distinct().Count());
        var queue = new ConfigQueue(null);
        Assert.True(queue.Enqueue(new ConfigUploadSnapshot
        {
            ObservedAt = Fixtures.Start, Category = category.Category, Hash = category.Hash,
            Truncated = category.Truncated, Items = category.Items,
        }), queue.LastRefusal);
    }

    [Fact]
    public void Every_category_the_builders_make_is_a_valid_upload_and_a_valid_snapshot_answer()
    {
        var queue = new ConfigQueue(null);
        var made = ConfigCollectorTests.EveryCategory();
        Assert.Equal(ConfigCollector.All.Count, made.Count);
        foreach (var c in made) Assert.True(queue.Enqueue(new ConfigUploadSnapshot { ObservedAt = Fixtures.Start, Category = c.Category, Hash = c.Hash, Truncated = c.Truncated, Items = c.Items }), c.Category.ToString());
        var answer = JsonSerializer.SerializeToElement(new ConfigSnapshotOutput { TakenAt = Fixtures.Start, Categories = made }, ContractJson.Options);
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.ConfigSnapshot), answer));
    }
}

public class ConfigCollectorTests
{
    private static JsonElement Json<T>(T value) => JsonSerializer.SerializeToElement(value, ContractJson.Options);

    private static TimeStatusOutput TimeNow() => new()
    {
        TimeZoneId = "Eastern Standard Time", TimeZoneName = "Eastern", UtcOffsetMinutes = -300, DaylightSavingNow = false, LocalTime = "x", UtcTime = Fixtures.Start,
        TimeService = TimeServiceState.Running, Sync = new TimeSync { State = TimeSyncState.Synced, Source = null, LastSuccessfulSync = null }, PolicyManaged = false,
    };

    /// <summary>Every operation the collector may call, answered with plausible output; anything else is refused, as the real registry would.</summary>
    internal static JsonElement Answer(string operation) => operation switch
    {
        Catalog.NetworkConfig => Json(new NetworkConfigOutput { Adapters = [new NetworkAdapter { InterfaceIndex = 12, Name = "Ethernet", Description = null, Type = AdapterType.Ethernet, Connected = true,
            LinkSpeedBps = 1_000_000_000, MacAddress = "00-1B-21-13-4F-5C", Ipv4 = new Ipv4Settings { Dhcp = true, Addresses = [new Ipv4Address { Address = "10.21.4.25", PrefixLength = 24 }], Gateways = ["10.21.4.1"] },
            Ipv6Addresses = [], Dns = new DnsSettings { Automatic = true, Servers = ["10.21.4.10"] }, DnsSuffix = null }] }),
        Catalog.ServicesList => Json(new ServicesListOutput { Watched = [], Services = [new ServiceInfo { Name = "Spooler", DisplayName = "Print Spooler", State = ServiceState.Running, StartType = ServiceStartType.Automatic,
            Account = "LocalSystem", ProcessId = 1, ExecutablePath = "C:\\Windows\\System32\\spoolsv.exe", Description = null, Recovery = null }] }),
        Catalog.DriversList => Json(new DriversListOutput { Truncated = false, Drivers = [new DriverInfo { PublishedName = "oem42.inf", OriginalName = "bio.inf", Version = "3.1.0.7", Date = Fixtures.Start, Provider = "Vendor", ClassName = "Biometric", Signer = "Microsoft" }] }),
        Catalog.UpdatesStatus => Json(new UpdatesStatusOutput { LastCheckAt = null, LastInstallAt = null, LastInstallResult = null, Pending = [],
            Installed = [new InstalledUpdate { Title = "Update (KB5050011)", Kb = "KB5050011", InstalledAt = Fixtures.Start, Result = UpdateResult.Succeeded, ErrorCode = null }] }),
        Catalog.FirewallState => Json(new FirewallStateOutput { RulesTruncated = false, Snapshots = [], Rules = [new ReportedFirewallRule { Name = "Allow Sync", Direction = FirewallDirection.In, Action = FirewallAction.Allow, Enabled = true, CreatedByPlatform = false }],
            Profiles = [new FirewallProfileState { Profile = FirewallProfile.Domain, Enabled = false, DefaultInbound = FirewallAction.Block, DefaultOutbound = FirewallAction.Allow, ReenableAt = null }] }),
        Catalog.TimeStatus => Json(TimeNow()),
        Catalog.DevicesList => Json(new DevicesListOutput { Truncated = false, Devices = [new DeviceInfo { InstanceId = "USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2", Class = "Biometric", Name = "Fingerprint Reader", Status = "OK", ErrorCode = null, ErrorText = null, HardwareIds = [], Driver = null }] }),
        Catalog.SoftwareList => Json(new SoftwareListOutput { TakenAt = Fixtures.Start, Truncated = false, Hotfixes = [], Programs = [new InstalledProgram { Name = "BioScan Client", Version = "4.2.1", Publisher = "BioScan", InstalledOn = null }] }),
        Catalog.NetworkHosts => Json(new NetworkHostsOutput { TakenAt = Fixtures.Start, Truncated = false, Entries = [new HostsEntry { Address = "127.0.0.1", Names = ["localhost"] }] }),
        Catalog.StartupList => Json(new StartupListOutput { TakenAt = Fixtures.Start, Truncated = false, Startup = [new StartupItem { Name = "BioScan", Command = "\"C:\\bio\\scan.exe\" -x", Location = "HKLM Run" }],
            Tasks = [new ScheduledTaskInfo { Path = "\\", Name = "Check", State = TaskState.Ready, LastRun = null, LastResult = null, NextRun = null }] }),
        Catalog.SystemHardware => Json(new SystemHardwareOutput { TakenAt = Fixtures.Start, Manufacturer = "Dell Inc.", Model = "OptiPlex 7090", Bios = new BiosInfo { Vendor = "Dell", Version = "1.18.0", Date = null },
            Cpu = new CpuInfo { Model = "i5", LogicalCores = 12 }, Memory = new MemoryInfo { TotalBytes = 17179869184, ModuleCount = 2, Modules = [] }, Tpm = null, SecureBoot = SecureBootState.Unsupported, LastBoot = null, Monitors = [], Ports = [] }),
        Catalog.SystemIdentity => Json(new SystemIdentityOutput { TakenAt = Fixtures.Start, JoinType = JoinType.Workgroup, Name = "WORKGROUP", DomainControllerFound = null, LocalAdministrators = null, AutoLogon = null, GroupPolicyLastApplied = null }),
        _ => throw new OperationFailedException("unavailable", "no"),
    };

    internal static IReadOnlyList<ConfigSnapshotCategory> EveryCategory() =>
        new ConfigCollector((op, _, _) => Task.FromResult(Answer(op)), "CAB-01", new ManualClock(Fixtures.Start), _ => { }).CollectAsync(null, CancellationToken.None).GetAwaiter().GetResult().Categories;

    [Fact]
    public async Task All_eleven_categories_are_collected_from_existing_catalog_reads_only()
    {
        var asked = new List<string>();
        var collector = new ConfigCollector((op, p, _) => { asked.Add(op); return Task.FromResult(Answer(op)); }, "CAB-01", new ManualClock(Fixtures.Start), _ => { });
        var all = await collector.CollectAsync(null, CancellationToken.None);
        Assert.Equal(Enum.GetValues<ConfigCategory>(), all.Categories.Select(c => c.Category));
        Assert.All(asked, op => Assert.True(Catalog.TryGet(op, out CatalogEntry e) && e.Kind == OperationKind.Read, $"{op} is a catalog read"));
        Assert.DoesNotContain(Catalog.ConfigSnapshot, asked);
    }

    [Fact]
    public async Task A_category_that_cannot_be_read_is_left_out_not_sent_partly()
    {
        var logged = new List<string>();
        var collector = new ConfigCollector((op, _, _) => op == Catalog.TimeStatus ? Task.FromResult(Answer(op)) : throw new OperationFailedException("unavailable", "no"), "CAB-01", new ManualClock(Fixtures.Start), logged.Add);
        var all = await collector.CollectAsync(null, CancellationToken.None);
        Assert.Equal([ConfigCategory.Time], all.Categories.Select(c => c.Category));
        Assert.Equal(10, logged.Count);
        var only = await collector.CollectAsync([ConfigCategory.Services], CancellationToken.None);
        Assert.Empty(only.Categories);
    }

    [Fact]
    public async Task A_read_that_answers_garbage_or_something_unexpected_is_left_out_and_never_crashes_the_collector()
    {
        var collector = new ConfigCollector((op, _, _) => Task.FromResult(op == Catalog.ServicesList ? JsonDocument.Parse("{\"services\":\"not a list\"}").RootElement.Clone()
            : op == Catalog.NetworkHosts ? JsonDocument.Parse("{\"entries\":[{\"address\":\"1.1.1.1\",\"names\":[],\"script\":\"x\"}],\"takenAt\":\"2026-01-01T00:00:00Z\",\"truncated\":false}").RootElement.Clone() : Answer(op)),
            "CAB-01", new ManualClock(Fixtures.Start), _ => { });
        var all = await collector.CollectAsync(null, CancellationToken.None);
        Assert.DoesNotContain(all.Categories, c => c.Category is ConfigCategory.Services or ConfigCategory.Hosts);
        Assert.Contains(all.Categories, c => c.Category == ConfigCategory.Time);
    }

    [Fact]
    public async Task Cancellation_stops_the_collection()
    {
        using var cts = new CancellationTokenSource();
        var collector = new ConfigCollector((op, _, _) => { cts.Cancel(); return Task.FromResult(Answer(op)); }, "CAB-01", new ManualClock(Fixtures.Start), _ => { });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => collector.CollectAsync(null, cts.Token));
    }
}

public class ConfigQueueAndWatchTests
{
    private static ConfigSnapshotCategory Category(ConfigCategory category, string value) => ConfigBuilders.Make(category, [new ConfigItem
    {
        Key = category == ConfigCategory.Time ? "time" : "service:x", Values = new Dictionary<string, object?> { ["v"] = value },
    }]);

    private static ConfigSnapshotOutput Look(ManualClock clock, params ConfigSnapshotCategory[] categories) => new() { TakenAt = clock.Now, Categories = categories };

    private static ConfigUploadSnapshot Snapshot(ManualClock clock, ConfigCategory category, string value, int minutes = 0)
    {
        var c = Category(category, value);
        return new ConfigUploadSnapshot { ObservedAt = clock.Now.AddMinutes(minutes), Category = c.Category, Hash = c.Hash, Truncated = false, Items = c.Items };
    }

    private static ConfigUpload Parse(string body) => JsonSerializer.Deserialize<ConfigUpload>(body, ContractJson.Options)!;

    [Fact]
    public void The_first_look_is_queued_an_unchanged_look_queues_nothing_and_a_change_queues_only_what_changed()
    {
        var clock = new ManualClock(Fixtures.Start);
        var queue = new ConfigQueue(null);
        var watch = new ConfigWatch(new StateFile<ConfigWatch.State>(null), queue, clock, _ => { });
        Assert.Equal(2, watch.Observe(Look(clock, Category(ConfigCategory.Services, "a"), Category(ConfigCategory.Time, "z"))));
        clock.Advance(TimeSpan.FromMinutes(10));
        Assert.Equal(0, watch.Observe(Look(clock, Category(ConfigCategory.Services, "a"), Category(ConfigCategory.Time, "z"))));
        clock.Advance(TimeSpan.FromMinutes(10));
        Assert.Equal(1, watch.Observe(Look(clock, Category(ConfigCategory.Services, "b"), Category(ConfigCategory.Time, "z"))));
        Assert.Equal(3, queue.Count);
        var (body, count) = queue.Peek()!.Value;
        Assert.Equal(3, count);
        var upload = Parse(body);
        Assert.Equal([ConfigCategory.Services, ConfigCategory.Time, ConfigCategory.Services], upload.Snapshots.Select(s => s.Category));
        using (JsonDocument doc = JsonDocument.Parse(body)) Assert.True(ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("config-upload"), doc.RootElement), "what is sent is a valid upload");
        queue.Acknowledge(3);
        Assert.Null(queue.Peek());
    }

    [Fact]
    public void Every_category_is_sent_again_after_a_day_even_when_nothing_changed()
    {
        var clock = new ManualClock(Fixtures.Start);
        var watch = new ConfigWatch(new StateFile<ConfigWatch.State>(null), new ConfigQueue(null), clock, _ => { });
        Assert.Equal(1, watch.Observe(Look(clock, Category(ConfigCategory.Time, "z"))));
        clock.Advance(TimeSpan.FromHours(23));
        Assert.Equal(0, watch.Observe(Look(clock, Category(ConfigCategory.Time, "z"))));
        clock.Advance(TimeSpan.FromHours(2));
        Assert.Equal(1, watch.Observe(Look(clock, Category(ConfigCategory.Time, "z"))));
        // A clock set back far enough that the last send is in the future also sends, instead of waiting for the clock to catch up.
        clock.Advance(TimeSpan.FromDays(-3));
        Assert.Equal(1, watch.Observe(Look(clock, Category(ConfigCategory.Time, "z"))));
    }

    [Fact]
    public void A_snapshot_the_server_refused_is_looked_at_again_at_the_next_look()
    {
        var clock = new ManualClock(Fixtures.Start);
        var queue = new ConfigQueue(null);
        var watch = new ConfigWatch(new StateFile<ConfigWatch.State>(null), queue, clock, _ => { });
        queue.Discarded += watch.Forget;
        Assert.Equal(1, watch.Observe(Look(clock, Category(ConfigCategory.Time, "z"))));
        clock.Advance(TimeSpan.FromMinutes(15));
        Assert.Equal(0, watch.Observe(Look(clock, Category(ConfigCategory.Time, "z"))));
        queue.Discard(queue.Peek()!.Value.Count);
        Assert.Equal(0, queue.Count);
        clock.Advance(TimeSpan.FromMinutes(15));
        Assert.Equal(1, watch.Observe(Look(clock, Category(ConfigCategory.Time, "z"))));
    }

    [Fact]
    public void An_outage_loses_nothing_the_queue_survives_a_restart_and_keeps_every_distinct_version()
    {
        using var dir = new TempDir();
        var clock = new ManualClock(Fixtures.Start);
        var first = new ConfigQueue(dir.File("q.jsonl"));
        var watch = new ConfigWatch(new StateFile<ConfigWatch.State>(dir.File("state.json")), first, clock, _ => { });
        foreach (string v in new[] { "a", "b", "c" }) { watch.Observe(Look(clock, Category(ConfigCategory.Services, v))); clock.Advance(TimeSpan.FromMinutes(10)); }
        var restarted = new ConfigQueue(dir.File("q.jsonl"));
        Assert.Equal(3, restarted.Count);
        Assert.Equal(3, Parse(restarted.Peek()!.Value.Body).Snapshots.Count);
        // And the watcher remembers what it already queued: the same look after a restart queues nothing.
        var again = new ConfigWatch(new StateFile<ConfigWatch.State>(dir.File("state.json")), restarted, clock, _ => { });
        Assert.Equal(0, again.Observe(Look(clock, Category(ConfigCategory.Services, "c"))));
    }

    [Fact]
    public void The_queue_is_bounded_the_oldest_is_dropped_and_the_next_snapshot_says_something_was_lost()
    {
        var clock = new ManualClock(Fixtures.Start);
        var queue = new ConfigQueue(null);
        for (int i = 0; i < ConfigQueue.MaxEntries + 3; i++) queue.Enqueue(Snapshot(clock, ConfigCategory.Services, "v" + i, i));
        Assert.Equal(ConfigQueue.MaxEntries, queue.Count);
        Assert.Equal(3, queue.Dropped);
        var first = Parse(queue.Peek()!.Value.Body).Snapshots[0];
        Assert.True(first.GapBefore);
        Assert.Equal(clock.Now.AddMinutes(3), first.ObservedAt);
    }

    [Fact]
    public void The_queue_is_bounded_in_bytes_too_and_when_everything_of_a_category_was_dropped_the_next_one_says_so()
    {
        var clock = new ManualClock(Fixtures.Start);
        var queue = new ConfigQueue(null);
        ConfigUploadSnapshot Heavy(int n) => new()
        {
            ObservedAt = clock.Now.AddMinutes(n), Category = ConfigCategory.Applications, Truncated = false,
            Hash = ConfigCanonical.Hash(HeavyItems(n)), Items = HeavyItems(n),
        };
        List<ConfigItem> HeavyItems(int n) => Enumerable.Range(0, 1000).Select(i => new ConfigItem { Key = $"app:big {n} {i:0000}", Values = new Dictionary<string, object?> { ["version"] = new string('v', 150), ["publisher"] = new string('p', 150) } }).ToList();
        for (int i = 0; i < 12; i++) Assert.True(queue.Enqueue(Heavy(i)));
        Assert.True(queue.Count < 12, "the byte budget dropped the oldest");
        Assert.True(queue.Dropped > 0);
        Assert.True(Parse(queue.Peek()!.Value.Body).Snapshots[0].GapBefore);
    }

    [Fact]
    public void One_upload_stays_under_the_request_limit_and_a_single_large_snapshot_is_still_sent_alone()
    {
        var clock = new ManualClock(Fixtures.Start);
        var queue = new ConfigQueue(null);
        List<ConfigItem> Items(int n) => Enumerable.Range(0, 900).Select(i => new ConfigItem { Key = $"app:app {n} {i:0000}", Values = new Dictionary<string, object?> { ["version"] = new string('v', 190), ["publisher"] = new string('p', 190) } }).ToList();
        foreach (int n in new[] { 1, 2, 3 })
            queue.Enqueue(new ConfigUploadSnapshot { ObservedAt = clock.Now.AddMinutes(n), Category = ConfigCategory.Applications, Truncated = false, Hash = ConfigCanonical.Hash(Items(n)), Items = Items(n) });
        var (body, count) = queue.Peek()!.Value;
        Assert.InRange(count, 1, 3);
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(body) < 1024 * 1024, "under the server's 1 MB request limit");
        if (count > 1) Assert.True(body.Length <= ConfigQueue.MaxBodyBytes + 16);
        queue.Acknowledge(count);
        Assert.NotNull(queue.Peek());
    }

    [Fact]
    public void A_damaged_or_hostile_queue_file_is_ignored_line_by_line_and_a_snapshot_that_breaks_its_contract_is_not_kept()
    {
        using var dir = new TempDir();
        var good = new ConfigQueue(null);
        var c = Category(ConfigCategory.Time, "z");
        var line = JsonSerializer.Serialize(new ConfigUploadSnapshot { ObservedAt = Fixtures.Start, Category = c.Category, Hash = c.Hash, Truncated = false, Items = c.Items }, ContractJson.Options);
        File.WriteAllText(dir.File("q.jsonl"), "not json\n" + line + "\n{\"category\":\"registry\",\"hash\":\"x\"}\n{\"snapshots\":[]}\n" + new string('x', 5000) + "\n");
        Assert.Equal(1, new ConfigQueue(dir.File("q.jsonl")).Count);
        var bad = new ConfigUploadSnapshot { ObservedAt = Fixtures.Start, Category = ConfigCategory.Time, Hash = "short", Truncated = false, Items = c.Items };
        Assert.False(good.Enqueue(bad));
        var control = new ConfigUploadSnapshot { ObservedAt = Fixtures.Start, Category = ConfigCategory.Time, Hash = c.Hash, Truncated = false,
            Items = [new ConfigItem { Key = "time", Values = new Dictionary<string, object?> { ["v"] = "a\u0007b" } }] };
        Assert.False(good.Enqueue(control));
        var nested = new ConfigUploadSnapshot { ObservedAt = Fixtures.Start, Category = ConfigCategory.Time, Hash = c.Hash, Truncated = false,
            Items = [new ConfigItem { Key = "time", Values = new Dictionary<string, object?> { ["v"] = JsonDocument.Parse("{\"run\":\"cmd\"}").RootElement.Clone() } }] };
        Assert.False(good.Enqueue(nested), "an object is not a configuration value");
        Assert.Equal(0, good.Count);
        // The reason a refusal gives is there for the log, and a snapshot that is taken clears it again.
        Assert.NotNull(good.LastRefusal);
        Assert.True(good.Enqueue(new ConfigUploadSnapshot { ObservedAt = Fixtures.Start, Category = c.Category, Hash = c.Hash, Truncated = false, Items = c.Items }));
        Assert.Null(good.LastRefusal);
        // A file far larger than the queue may be is not read at all.
        File.WriteAllText(dir.File("huge.jsonl"), new string('x', 9 * 1024 * 1024));
        Assert.Equal(0, new ConfigQueue(dir.File("huge.jsonl")).Count);
    }
}

public class ConfigMonitorTests
{
    [Fact]
    public async Task The_monitor_looks_at_the_configuration_on_its_own_and_queues_only_what_changed()
    {
        string value = "a";
        int looks = 0;
        var queue = new ConfigQueue(null);
        var host = new MonitorHost(new MonitorSources
        {
            Config = _ =>
            {
                Interlocked.Increment(ref looks);
                var c = ConfigBuilders.Make(ConfigCategory.Services, [new ConfigItem { Key = "service:x", Values = new Dictionary<string, object?> { ["state"] = value } }]);
                return Task.FromResult(new ConfigSnapshotOutput { TakenAt = DateTimeOffset.UtcNow, Categories = [c] });
            },
        }, new MonitorSettings(null, null), new EventQueue(null), null, TimeProvider.System, _ => { },
            new MonitorIntervals { Config = TimeSpan.FromMilliseconds(40), FirstConfigLook = TimeSpan.FromMilliseconds(10) }, queue);
        using var cts = new CancellationTokenSource();
        Task running = host.RunAsync(cts.Token);
        async Task Until(Func<bool> check) { for (var end = DateTime.UtcNow.AddSeconds(10); !check(); await Task.Delay(10)) if (DateTime.UtcNow > end) throw new TimeoutException(); }
        await Until(() => Volatile.Read(ref looks) >= 5);
        Assert.Equal(1, queue.Count);             // five looks, one unchanged configuration: one snapshot, the starting point
        value = "b";
        await Until(() => queue.Count == 2);
        int seen = Volatile.Read(ref looks);
        await Until(() => Volatile.Read(ref looks) >= seen + 4);
        Assert.Equal(2, queue.Count);             // and silent again until it changes
        cts.Cancel();
        try { await running; } catch (OperationCanceledException) { }
    }
}
