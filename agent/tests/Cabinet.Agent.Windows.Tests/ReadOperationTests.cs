using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Windows;
using Xunit;

namespace Cabinet.Agent.Windows.Tests;

/// <summary>
/// Every read operation, through the full command path on a real Windows
/// machine, producing output that passes its contract. The CI runner is an
/// administrator, which the broker reads need.
/// </summary>
public sealed class ReadOperationTests
{
    private static readonly AgentConfig Config = new()
    {
        CabinetId = Guid.Parse("9b2d7c1e-5a4f-4e3b-8c2d-1f0e9a8b7c6d"), ReadOnlyMode = false, CabinetRole = CabinetRole.Standalone,
        Scanner = new ScannerConfig { HardwareIds = ["USB\\VID_1234&PID_5678"] },
        SyncCabinet = new SyncCabinetConfig { Address = "127.0.0.1" }, PlatformServer = new PlatformServerConfig { Host = "localhost", Port = null },
        AllowedTcpPorts = [135], LocalHarness = false,
    };

    private static async Task<Result> Run(string operation, object? parameters = null)
    {
        TimeProvider clock = TimeProvider.System;
        BrokerClient broker = InProcessBroker.Client(new BrokerRequestHandler(BrokerReadOperations.Registry()));
        var processor = new CommandProcessor(
            new CommandValidator(Config, new ReplayStore(null, clock), new RateLimiter(null, clock), clock),
            NetworkOperations.Registry(Config, broker, clock), clock) { Timeout = TimeSpan.FromMinutes(3) };
        Command command = CommandFile.Make(Config, operation, JsonSerializer.SerializeToElement(parameters ?? new { }), clock.GetUtcNow());
        var (result, dropped) = await processor.ProcessAsync(JsonSerializer.SerializeToUtf8Bytes(command, ContractJson.Options), CancellationToken.None);
        Assert.Null(dropped);
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Envelope("result"), JsonSerializer.SerializeToElement(result, ContractJson.Options)));
        return result!;
    }

    private static async Task<JsonElement> Succeeds(string operation, object? parameters = null)
    {
        Result result = await Run(operation, parameters);
        Assert.True(result.Status == ResultStatus.Succeeded, $"{operation}: {result.Error?.Code} {result.Error?.Message}");
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(operation), result.Output!.Value));
        return result.Output.Value;
    }

    private static void MatchesContract(string operation, object output) =>
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(operation), JsonSerializer.SerializeToElement(output, ContractJson.Options)));

    [Fact]
    public void System_hardware_matches_its_contract_and_names_the_machine()
    {
        SystemHardwareOutput output = HardwareOperations.Hardware();
        MatchesContract(Catalog.SystemHardware, output);
        Assert.True(output.Cpu.LogicalCores > 0);
    }

    [Fact]
    public void System_identity_matches_its_contract_and_never_carries_a_password()
    {
        SystemIdentityOutput output = HardwareOperations.Identity();
        MatchesContract(Catalog.SystemIdentity, output);
        Assert.DoesNotContain("password", JsonSerializer.Serialize(output, ContractJson.Options), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Network_hosts_matches_its_contract()
    {
        NetworkHostsOutput output = HardwareOperations.Hosts();
        MatchesContract(Catalog.NetworkHosts, output);
        Assert.True(output.Entries.Count <= 500);
    }

    [Fact]
    public async Task Config_snapshot_collects_the_cabinets_configuration_from_the_other_reads_with_hashes_the_server_will_accept()
    {
        JsonElement output = await Succeeds(Catalog.ConfigSnapshot);
        var snapshot = output.Deserialize<ConfigSnapshotOutput>(ContractJson.Options)!;
        Assert.NotEmpty(snapshot.Categories);
        foreach (ConfigSnapshotCategory c in snapshot.Categories)
        {
            Assert.Equal(Core.Configuration.ConfigCanonical.Hash(c.Items), c.Hash);
            Assert.True(c.Items.Count <= Core.Configuration.ConfigBuilders.MaxItems);
        }
        JsonElement one = await Succeeds(Catalog.ConfigSnapshot, new { categories = new[] { "time" } });
        Assert.Single(one.GetProperty("categories").EnumerateArray());
    }

    [Fact]
    public async Task System_info() => Assert.False(string.IsNullOrEmpty((await Succeeds(Catalog.SystemInfo)).GetProperty("osBuild").GetString()));

    [Fact]
    public async Task Event_log_channels_cover_every_allowed_log()
    {
        JsonElement output = await Succeeds(Catalog.EventlogChannels);
        Assert.Equal(Catalog.AllowedLogs.Count, output.GetProperty("channels").GetArrayLength());
        Assert.Contains(output.GetProperty("channels").EnumerateArray(), c => c.GetProperty("log").GetString() == "System" && c.GetProperty("available").GetBoolean());
    }

    [Fact]
    public async Task Event_log_query_then_get_the_newest_entry()
    {
        JsonElement page = await Succeeds(Catalog.EventlogQuery, new { log = "System", pageSize = 5 });
        Assert.InRange(page.GetProperty("entries").GetArrayLength(), 1, 5);
        long id = page.GetProperty("entries")[0].GetProperty("recordId").GetInt64();
        JsonElement entry = await Succeeds(Catalog.EventlogGet, new { log = "System", recordId = id });
        Assert.Equal(id, entry.GetProperty("recordId").GetInt64());
        Assert.StartsWith("<Event", entry.GetProperty("rawXml").GetString());

        JsonElement next = await Succeeds(Catalog.EventlogQuery, new { log = "System", pageSize = 5, beforeRecordId = id });
        Assert.All(next.GetProperty("entries").EnumerateArray(), e => Assert.True(e.GetProperty("recordId").GetInt64() < id));
    }

    [Fact]
    public async Task Event_log_get_for_a_missing_record_is_not_found()
    {
        Result result = await Run(Catalog.EventlogGet, new { log = "Application", recordId = 9_000_000_000_000L });
        Assert.Equal("not_found", result.Error!.Code);
    }

    [Fact]
    public async Task Every_allowed_log_can_be_queried_or_reports_it_is_missing()
    {
        foreach (string log in Catalog.AllowedLogs)
        {
            Result result = await Run(Catalog.EventlogQuery, new { log, pageSize = 1 });
            Assert.True(result.Status == ResultStatus.Succeeded || result.Error?.Code == "unavailable", $"{log}: {result.Error?.Code} {result.Error?.Message}");
        }
    }

    [Fact]
    public async Task Devices_and_drivers() 
    {
        Assert.True((await Succeeds(Catalog.DevicesList)).GetProperty("devices").GetArrayLength() > 0);
        await Succeeds(Catalog.DevicesList, new { problemsOnly = true });
        Assert.True((await Succeeds(Catalog.DriversList)).GetProperty("drivers").GetArrayLength() > 0);
    }

    [Fact]
    public async Task Peripheral_status_runs_the_whole_checklist()
    {
        JsonElement output = await Succeeds(Catalog.PeripheralStatus);
        Assert.Equal(8, output.GetProperty("checks").GetArrayLength());
    }

    [Fact]
    public async Task Updates_status() => await Succeeds(Catalog.UpdatesStatus);

    [Fact]
    public async Task Disk_smart() => await Succeeds(Catalog.DiskSmart);

    [Fact]
    public async Task Files_list_pages_a_directory_and_refuses_junctions()
    {
        JsonElement output = await Succeeds(Catalog.FilesList, new { path = "C:\\Windows", pageSize = 10 });
        Assert.Equal(10, output.GetProperty("entries").GetArrayLength());
        Assert.True(output.GetProperty("hasMore").GetBoolean());
        // "C:\Documents and Settings" is a junction on every modern Windows.
        Result junction = await Run(Catalog.FilesList, new { path = "C:\\Documents and Settings" });
        Assert.Contains(junction.Error?.Code, new[] { "unavailable", "execution_failed" });
        Assert.Equal("not_found", (await Run(Catalog.FilesList, new { path = "C:\\does-not-exist-" + Guid.NewGuid().ToString("N") })).Error!.Code);
    }

    [Fact]
    public async Task Network_config() => Assert.True((await Succeeds(Catalog.NetworkConfig)).GetProperty("adapters").GetArrayLength() > 0);

    [Fact]
    public async Task Network_tests_reach_their_configured_targets()
    {
        await Succeeds(Catalog.NetworkTest, new { target = "gateway", method = "ping" });
        JsonElement tcp = await Succeeds(Catalog.NetworkTest, new { target = "sync_cabinet", method = "tcp", port = 135 });
        Assert.True(tcp.GetProperty("success").GetBoolean(), tcp.GetProperty("error").ToString()); // RPC endpoint mapper listens on every Windows machine
        JsonElement dns = await Succeeds(Catalog.NetworkTest, new { target = "platform_server", method = "dns" });
        Assert.True(dns.GetProperty("success").GetBoolean());
        await Succeeds(Catalog.NetworkTest, new { target = "dns_server", method = "ping", dnsServerIndex = 0 });
        Assert.Equal("invalid_params", (await Run(Catalog.NetworkTest, new { target = "sync_cabinet", method = "tcp", port = 445 })).Error!.Code);
    }

    [Fact]
    public async Task Firewall_state()
    {
        JsonElement output = await Succeeds(Catalog.FirewallState);
        Assert.Equal(3, output.GetProperty("profiles").GetArrayLength());
        Assert.True(output.GetProperty("rules").GetArrayLength() > 0);
    }

    [Fact]
    public async Task System_performance_reports_memory_and_drives()
    {
        JsonElement output = await Succeeds(Catalog.SystemPerformance);
        Assert.True(output.GetProperty("memory").GetProperty("totalBytes").GetInt64() > 0);
        Assert.True(output.GetProperty("volumes").GetArrayLength() > 0);
    }

    [Fact]
    public async Task Network_listeners_finds_something_listening()
    {
        JsonElement output = await Succeeds(Catalog.NetworkListeners);
        Assert.True(output.GetProperty("counts").GetProperty("listening").GetInt64() > 0);
    }
}
