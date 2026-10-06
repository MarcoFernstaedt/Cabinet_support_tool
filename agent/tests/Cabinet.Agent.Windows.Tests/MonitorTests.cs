using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Windows;
using Xunit;

namespace Cabinet.Agent.Windows.Tests;

/// <summary>The background monitors against a real Windows machine: each source reads, and what they raise passes the event contract.</summary>
public sealed class MonitorTests
{
    private static readonly AgentConfig Config = new()
    {
        CabinetId = null, ReadOnlyMode = false, CabinetRole = CabinetRole.Standalone,
        Scanner = new ScannerConfig { HardwareIds = ["USB\\VID_1234&PID_5678"] },
        SyncCabinet = new SyncCabinetConfig { Address = null }, PlatformServer = new PlatformServerConfig { Host = null, Port = null },
        AllowedTcpPorts = [], LocalHarness = false,
    };

    private static MonitorSources Sources() =>
        WindowsMonitors.Sources(Config, InProcessBroker.Client(new BrokerRequestHandler(BrokerReadOperations.Registry())));

    [Fact]
    public async Task Every_source_reads_and_every_event_passes_its_contract()
    {
        var s = Sources();
        var queue = new EventQueue(null);
        var now = DateTimeOffset.UtcNow;

        var devices = await s.Devices!(default);
        Assert.NotEmpty(devices);
        // The CI machine has no scanner with this ID, so the first look reports it disconnected.
        var scanner = new ScannerWatch().Observe(Config.Scanner.HardwareIds, devices, now);
        Assert.Equal(ScannerState.Disconnected, scanner!.Device!.State);
        Assert.True(queue.Enqueue(scanner));

        var firewall = new FirewallWatch(new StateFile<FirewallWatch.State>(null));
        Assert.Null(firewall.Check(await s.Firewall!(default), now)); // baseline
        Assert.Null(firewall.Check(await s.Firewall!(default), now)); // nothing changed in between

        var logs = await s.Logs!(default);
        Assert.Contains("System", logs);
        var watch = new EventLogWatch(new StateFile<EventLogWatch.State>(null), s.Query!);
        foreach (string log in new[] { "System", "Application" })
            foreach (var e in await watch.CheckAsync(log, now, default))
                Assert.True(queue.Enqueue(e), $"{log} {e.Source!.RecordId}");

        var drives = await s.Drives!(default);
        foreach (var e in new DriveWatch(new StateFile<DriveWatch.State>(null)).Check(drives, now)) Assert.True(queue.Enqueue(e));
    }
}
