using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Server;
using Cabinet.Agent.Core.Packages;
using Cabinet.Agent.Core.Upgrades;
using Cabinet.Agent.Core.Writes;
using Cabinet.Agent.TestAgent;

// usage: test-agent <serverUrl> <platformCaPem> <stateDir> [contractsDir]
// With contractsDir, every other read operation answers with its first valid example output
// from contracts/examples, so the console can be exercised end to end without Windows.
// The background monitors run against files a test writes into <stateDir>/simulate:
//   devices.json        a JSON array of DeviceFacts (the scanner watcher's view of Device Manager)
//   events-<log>.json   a JSON array of EventSummary for that log (the event log watcher's view)
// Writes run through the agent's real broker logic (safety net, snapshots, timers, package checks) over an
// in-memory firewall and network. TEST_SAFETY_NET_SECONDS shortens the safety-net window; TEST_TRUST_DIR
// replaces the trusted publisher list (so tests can sign packages with their own CA); TEST_READ_ONLY=1 installs it read-only.
// Upgrades run through the agent's real download, broker check and journal; TEST_UPGRADE_TRUST_DIR holds the release keys
// (laid out like contracts/trust/upgrade) and the certificates the simulated Authenticode reads; TEST_UPGRADE_OUTCOME=rollback
// makes the simulated updater restore the old version. TEST_AGENT_VERSION sets the version the agent reports (default 0.2.0).
if (args.Length is < 3 or > 4) { Console.Error.WriteLine("usage: test-agent <serverUrl> <platformCaPem> <stateDir> [contractsDir]"); return 2; }
string? examples = args.Length == 4 ? Path.Combine(args[3], "examples", "operations") : null;
var server = new Uri(args[0]);
using var ca = X509Certificate2.CreateFromPem(File.ReadAllText(args[1]));
string state = args[2];
Directory.CreateDirectory(state);
var clock = TimeProvider.System;
var config = new AgentConfig
{
    CabinetId = null, ReadOnlyMode = Environment.GetEnvironmentVariable("TEST_READ_ONLY") == "1", CabinetRole = null, Scanner = new ScannerConfig { HardwareIds = [] },
    SyncCabinet = new SyncCabinetConfig { Address = null }, PlatformServer = new PlatformServerConfig { Host = server.Host, Port = server.Port },
    AllowedTcpPorts = [], LocalHarness = false,
};
using var keys = new InMemoryKeyStore();
void Log(string message) { Console.WriteLine(message); Console.Out.Flush(); }
var firewall = new MemoryFirewall();
var safetyNet = new SafetyNet(Path.Combine(state, "safety-net.json"), clock,
    int.TryParse(Environment.GetEnvironmentVariable("TEST_SAFETY_NET_SECONDS"), out int seconds) ? TimeSpan.FromSeconds(seconds) : null);
var firewallStore = new FirewallStore(Path.Combine(state, "firewall"));
var writes = new BrokerWrites(firewall, new MemoryNetwork(), safetyNet, firewallStore, clock, Log);
var trust = Environment.GetEnvironmentVariable("TEST_TRUST_DIR") is { Length: > 0 } trustDir ? TrustList.FromFolder(trustDir) : TrustList.Compiled;
var installer = new PackageInstaller(Path.Combine(state, "downloads"), Path.Combine(state, "staging"), trust, new SimulatedPackagePlatform(Log), Log);
var packages = new PackageDownloads(Path.Combine(state, "downloads"));
string agentVersion = Environment.GetEnvironmentVariable("TEST_AGENT_VERSION") is { Length: > 0 } v ? v : "0.2.0";
string? upgradeTrustDir = Environment.GetEnvironmentVariable("TEST_UPGRADE_TRUST_DIR") is { Length: > 0 } u ? u : null;
UpgradeTrust upgradeTrust = upgradeTrustDir is null ? UpgradeTrust.Compiled : UpgradeTrust.FromFolder(upgradeTrustDir);
var journal = new UpgradeJournalStore(Path.Combine(state, "broker", "upgrade.json"));
var upgradeBroker = new UpgradeBroker(new ReleaseVerifier(upgradeTrust, new MarkerAuthenticode(upgradeTrustDir ?? state)), journal, Path.Combine(state, "downloads"),
    Path.Combine(state, "staging-upgrade"), agentVersion, new SimulatedUpdater(journal, Environment.GetEnvironmentVariable("TEST_UPGRADE_OUTCOME") == "rollback", Log), clock, Log);
MonitorHost? monitorHost = null;
string simulate = Path.Combine(state, "simulate");
Directory.CreateDirectory(simulate);
var events = new EventQueue(Path.Combine(state, "events.jsonl"));
var settings = new MonitorSettings(Path.Combine(state, "monitor-settings.json"));
// Services (milestone 10): the broker's real service logic and watcher over a simulated service manager.
Directory.CreateDirectory(Path.Combine(state, "broker"));
var services = new SimulatedServices(simulate, Log);
var serviceWatcher = new Cabinet.Agent.Core.Services.ServiceWatcher(services, new StateFile<Cabinet.Agent.Core.Services.ServiceWatcher.Saved>(Path.Combine(state, "broker", "service-watch.json")), clock, Log);
var serviceControl = new Cabinet.Agent.Core.Services.ServiceControl(services, Log) { Watcher = serviceWatcher };
// Time zone and clock: the broker's real time logic over a simulated tzutil and w32tm.
var simulatedTime = new SimulatedTime(Log);
var timeOperations = new Cabinet.Agent.Core.Clock.TimeOperations(simulatedTime, Log, System.Globalization.CultureInfo.GetCultureInfo("en-US"));

var connection = new AgentConnection(new AgentConnectionOptions
{
    ServerUri = server, PlatformCa = ca, Keys = keys, Store = new IdentityStore(state), Config = config,
    ProcessorFor = c => new CommandProcessor(
        new CommandValidator(c, new ReplayStore(Path.Combine(state, "replay.log"), clock), new RateLimiter(null, clock), clock),
        new OperationRegistry()
            .Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo, (_, _) => Task.FromResult(new SystemInfoOutput
            {
                Hostname = "TEST-AGENT", OsVersion = Environment.OSVersion.VersionString, OsBuild = Environment.OSVersion.Version.Build.ToString(),
                UptimeSeconds = Environment.TickCount64 / 1000, AgentVersion = agentVersion, ReadOnlyMode = c.ReadOnlyMode, CabinetRole = c.CabinetRole, SerialNumber = null,
            }))
            .Register<NetworkTestParams, NetworkTestOutput>(Catalog.NetworkTest, new NetworkTester(c).RunAsync)
            .Register<EmptyParams, FirewallStateOutput>(Catalog.FirewallState, (_, _) => Task.FromResult(firewall.Read() with
            {
                Profiles = firewall.Read().Profiles.Select(p => p with { ReenableAt = firewallStore.TimersList().FirstOrDefault(t => t.Profile == p.Profile)?.ReenableAt }).ToList(),
                Snapshots = firewallStore.Snapshots().Take(20).ToList(),
            }))
            .WithWrites(writes, installer, packages)
            .WithServices(serviceControl)
            .WithBroker(timeOperations.Register(new OperationRegistry()))
            .WithExamples(examples),
        clock),
    Fingerprints = () => new EnrollFingerprints
    {
        Hostname = "TEST-AGENT", SerialNumber = "TEST-SERIAL", MacAddresses = [], ProvisionedClient = null, ProvisionedSite = null,
        OnlineSince = DateTimeOffset.UtcNow.AddMinutes(-Environment.TickCount64 / 60000), OsVersion = "test", AgentVersion = agentVersion,
    },
    AgentVersion = agentVersion, UptimeSeconds = () => Environment.TickCount64 / 1000, Log = Log,
    Events = events, Settings = settings, EventSendInterval = TimeSpan.FromMilliseconds(500), Packages = packages,
    Upgrades = new UpgradeCoordinator(Path.Combine(state, "downloads"), agentVersion, journal, Path.Combine(state, "check-in.json"), Path.Combine(state, "upgrade-reported"),
        (version, _) => { var (_, error) = upgradeBroker.Start(version); return Task.FromResult((error is null, error)); }, events, clock, Log),
    ConfirmSafetyNet = (id, _) => Task.FromResult(safetyNet.Confirm(id)), AfterWrite = () => monitorHost?.FirewallNow(),
    FirewallProfiles = () => monitorHost?.FirewallProfiles,
    TimeZoneId = () => simulatedTime.CurrentZone().Id,
    EnrollPollInterval = TimeSpan.FromSeconds(1), HeartbeatInterval = TimeSpan.FromSeconds(2),
    Backoff = new Backoff(TimeSpan.FromMilliseconds(500), TimeSpan.FromSeconds(3)),
});

using var stop = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };
AppDomain.CurrentDomain.ProcessExit += (_, _) => stop.Cancel();
T? Read<T>(string name) where T : class
{
    string file = Path.Combine(simulate, name);
    try { return File.Exists(file) ? System.Text.Json.JsonSerializer.Deserialize<T>(File.ReadAllText(file), ContractJson.Options) : null; }
    catch (Exception e) when (e is IOException or System.Text.Json.JsonException) { return null; } // being written: next look
}
var monitors = new MonitorHost(new MonitorSources
{
    Devices = _ => Task.FromResult<IReadOnlyList<DeviceFacts>>(Read<List<DeviceFacts>>("devices.json") ?? []),
    Firewall = _ => Task.FromResult(firewall.Read()),
    PlatformFirewallChange = firewallStore.CommandFor,
    Watch = (names, _) => { if (names is not null) serviceWatcher.SetList(names); return Task.FromResult(serviceWatcher.Status()); },
    Logs = _ => Task.FromResult<IReadOnlyList<string>>(["System", "Application"]),
    Query = (p, _) => Task.FromResult(new EventlogQueryOutput
    {
        Log = p.Log, NextBeforeRecordId = null, Truncated = false,
        Entries = (Read<List<EventSummary>>($"events-{p.Log}.json") ?? [])
            .Where(e => (p.From is null || e.Time >= p.From) && (p.BeforeRecordId is null || e.RecordId < p.BeforeRecordId))
            .OrderByDescending(e => e.RecordId).Take(p.PageSize ?? 100).ToList(),
    }),
}, settings, events, state, clock, Log, new MonitorIntervals { Scanner = TimeSpan.FromSeconds(1), EventLogs = TimeSpan.FromSeconds(1), FirstEventLogLook = TimeSpan.FromSeconds(1), WatchedServices = TimeSpan.FromSeconds(1) });
monitorHost = monitors;
var monitoring = monitors.RunAsync(stop.Token);
// The broker's upkeep: safety-net rollbacks and firewall timers.
var upkeep = Task.Run(async () =>
{
    while (!stop.IsCancellationRequested)
    {
        writes.Tick();
        serviceWatcher.Tick();
        try { await Task.Delay(TimeSpan.FromSeconds(1), stop.Token); } catch (OperationCanceledException) { }
    }
});
try { await connection.RunAsync(stop.Token); } catch (OperationCanceledException) { }
try { await monitoring; } catch (OperationCanceledException) { }
return 0;

static class ExampleRegistry
{
    /// <summary>Writes go straight to the broker logic (no pipe on Linux); package.install downloads first, as on a cabinet.</summary>
    public static OperationRegistry WithWrites(this OperationRegistry registry, BrokerWrites writes, PackageInstaller installer, PackageDownloads packages)
    {
        var broker = installer.Register(writes.Register(new OperationRegistry()));
        packages.Register(registry, (op, p, t) => broker.TryGet(op, out var h) ? h(p, t) : throw new InvalidOperationException());
        // TEST_WRITE_DELAY_MS makes a write take as long as a real one can (netsh, WMI), so a test can cut the link mid-command.
        int delay = int.TryParse(Environment.GetEnvironmentVariable("TEST_WRITE_DELAY_MS"), out int ms) ? ms : 0;
        foreach (string op in broker.Names.Where(n => !registry.Has(n)))
        {
            broker.TryGet(op, out var h);
            registry.RegisterRaw(op, async (p, t) => { if (delay > 0) await Task.Delay(delay, t); return await h(p, t); });
        }
        return registry;
    }

    /// <summary>Operations the broker would run, answered here through the broker's own logic.</summary>
    public static OperationRegistry WithBroker(this OperationRegistry registry, OperationRegistry broker)
    {
        foreach (string op in broker.Names) { broker.TryGet(op, out var h); registry.RegisterRaw(op, h); }
        return registry;
    }

    /// <summary>services.list and service.control through the broker's real logic; processes.list from this machine's processes.</summary>
    public static OperationRegistry WithServices(this OperationRegistry registry, Cabinet.Agent.Core.Services.ServiceControl services)
    {
        var broker = services.Register(new OperationRegistry());
        foreach (string op in broker.Names) { broker.TryGet(op, out var h); registry.RegisterRaw(op, h); }
        return registry.Register<EmptyParams, ProcessesListOutput>(Catalog.ProcessesList, (_, _) => Task.FromResult(new ProcessesListOutput
        {
            Processes = System.Diagnostics.Process.GetProcesses().Take(50).Select(p =>
            {
                using (p) return new ProcessInfo { ProcessId = p.Id, Name = p.ProcessName.Length > 0 ? p.ProcessName : "unknown", ExecutablePath = null, CpuPercent = 0,
                    WorkingSetBytes = Math.Max(0, p.WorkingSet64), PrivateBytes = 0, Threads = 1, Handles = 0, StartTime = null, SessionId = 0, Account = null };
            }).ToList(),
            SampleMilliseconds = 0, Truncated = false,
        }));
    }

    public static OperationRegistry WithExamples(this OperationRegistry registry, string? examplesDir)
    {
        if (examplesDir is null) return registry;
        foreach (CatalogEntry entry in Catalog.All.Where(e => e.Kind == OperationKind.Read && !registry.Has(e.Name)))
        {
            string dir = Path.Combine(examplesDir, entry.Name, "output", "valid");
            string? file = Directory.Exists(dir) ? Directory.EnumerateFiles(dir, "*.json").OrderByDescending(f => new FileInfo(f).Length).FirstOrDefault() : null;
            if (file is null) continue;
            var output = System.Text.Json.JsonDocument.Parse(File.ReadAllText(file)).RootElement.Clone();
            registry.RegisterRaw(entry.Name, (_, _) => Task.FromResult(output));
        }
        return registry;
    }
}
