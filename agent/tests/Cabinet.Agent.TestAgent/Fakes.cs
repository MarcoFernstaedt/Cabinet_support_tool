using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Packages;
using Cabinet.Agent.Core.Writes;

namespace Cabinet.Agent.TestAgent;

// The test agent runs on Linux, so the Windows parts of the writes are in memory here. Everything
// above them (the safety net, snapshots, timers, attribution, package checks) is the real agent code.

sealed class MemoryFirewall : IFirewallControl
{
    private readonly object _gate = new();
    public Dictionary<FirewallProfile, FirewallProfileState> Profiles { get; } = Enum.GetValues<FirewallProfile>().ToDictionary(p => p,
        p => new FirewallProfileState { Profile = p, Enabled = true, DefaultInbound = FirewallAction.Block, DefaultOutbound = FirewallAction.Allow, ReenableAt = null });
    public List<ReportedFirewallRule> Rules { get; } =
    [
        new() { Name = "Core Networking - DNS (UDP-Out)", Direction = FirewallDirection.Out, Action = FirewallAction.Allow, Protocol = "UDP", RemotePorts = "53", Enabled = true, CreatedByPlatform = false },
        new() { Name = "Remote Desktop - User Mode (TCP-In)", Direction = FirewallDirection.In, Action = FirewallAction.Allow, Protocol = "TCP", LocalPorts = "3389", Enabled = false, CreatedByPlatform = false },
    ];

    public FirewallStateOutput Read() { lock (_gate) return new() { Profiles = Profiles.Values.OrderBy(p => p.Profile).ToList(), Rules = Rules.ToList(), RulesTruncated = false, Snapshots = [] }; }
    public void SetProfile(FirewallProfile p, bool e, FirewallAction i, FirewallAction o) { lock (_gate) Profiles[p] = Profiles[p] with { Enabled = e, DefaultInbound = i, DefaultOutbound = o }; }
    public int CountRules(string name) { lock (_gate) return Rules.Count(r => r.Name == name); }
    public ReportedFirewallRule? ReadRule(string name) { lock (_gate) return Rules.FirstOrDefault(r => r.Name == name); }
    public void CreateRule(FirewallRule r) { lock (_gate) Rules.Add(Report(r)); }
    public void UpdateRule(string name, FirewallRule r) { lock (_gate) { Rules.RemoveAll(x => x.Name == name); Rules.Add(Report(r)); } }
    public void SetRuleEnabled(string name, bool enabled) { lock (_gate) { int i = Rules.FindIndex(r => r.Name == name); Rules[i] = Rules[i] with { Enabled = enabled }; } }
    public void DeleteRule(string name) { lock (_gate) Rules.RemoveAll(r => r.Name == name); }
    public void Export(string path) => File.WriteAllText(path, JsonSerializer.Serialize(Read(), ContractJson.Options));
    public void Import(string path)
    {
        var s = JsonSerializer.Deserialize<FirewallStateOutput>(File.ReadAllText(path), ContractJson.Options)!;
        lock (_gate) { foreach (var p in s.Profiles) Profiles[p.Profile] = p; Rules.Clear(); Rules.AddRange(s.Rules); }
    }

    private static string? Ports(IReadOnlyList<PortRange>? r) => r is { Count: > 0 } ? string.Join(',', r.Select(x => x.From == x.To ? $"{x.From}" : $"{x.From}-{x.To}")) : null;
    private static ReportedFirewallRule Report(FirewallRule r) => new()
    {
        Name = r.Name, Direction = r.Direction, Action = r.Action, Protocol = r.Protocol.ToString().ToUpperInvariant(), Enabled = r.Enabled,
        LocalPorts = Ports(r.LocalPorts), RemotePorts = Ports(r.RemotePorts),
        LocalAddresses = r.LocalAddresses is { Count: > 0 } la ? string.Join(',', la) : null, RemoteAddresses = r.RemoteAddresses is { Count: > 0 } ra ? string.Join(',', ra) : null,
        ProgramPath = r.ProgramPath, Profiles = r.Profiles, CreatedByPlatform = r.Name.StartsWith(BrokerWrites.PlatformRulePrefix, StringComparison.Ordinal),
    };
}

sealed class MemoryNetwork : INetworkControl
{
    public Ipv4Settings Ip = new() { Dhcp = true, Addresses = [new() { Address = "10.20.0.31", PrefixLength = 24 }], Gateways = ["10.20.0.1"] };
    public DnsSettings Dns = new() { Automatic = true, Servers = ["10.20.0.1"] };
    public const int Index = 12;
    public (Ipv4Settings Ip, DnsSettings Dns) Read(int i) => i == Index ? (Ip, Dns) : throw new OperationFailedException("not_found", "No adapter has that interface index.");
    public void SetDhcp(int i) { Read(i); Ip = Ip with { Dhcp = true }; }
    public void SetStatic(int i, string a, int p, string g) { Read(i); Ip = new() { Dhcp = false, Addresses = [new() { Address = a, PrefixLength = p }], Gateways = [g] }; }
    public void SetDns(int i, DnsSettings d) { Read(i); Dns = d; }
    public void Restore(int i, Ipv4Settings ip) { Read(i); Ip = ip; }
}

/// <summary>On Linux there is no WinVerifyTrust or pnputil: the managed checks are the agent's real ones; "installing" is recorded.</summary>
sealed class SimulatedPackagePlatform(Action<string> log) : IPackagePlatform
{
    public void VerifyWithWindows(string path) { }
    public (X509Certificate2 Signer, X509Certificate2Collection Certificates) ReadMsiSignature(string path) =>
        throw new PackageRefusedException("signature_invalid", "The test agent cannot read MSI signatures.");
    public (bool Installed, long ExitCode, bool RebootRequired) InstallDriver(IReadOnlyList<string> infs) { log($"Simulated install of {string.Join(", ", infs.Select(Path.GetFileName))}."); return (true, 0, false); }
    public (bool Installed, long ExitCode, bool RebootRequired) InstallMsi(string msi) => (false, 1603, false);
    public (bool Removed, bool RebootRequired) UninstallDriver(string name) => (name.StartsWith("oem", StringComparison.OrdinalIgnoreCase), false);
}

/// <summary>
/// A simulated service manager for the end-to-end tests. A test stops a service by writing its name into
/// simulate/stop-services.json; FlakySvc never starts; DisabledSvc is disabled.
/// </summary>
sealed class SimulatedServices(string simulateDir, Action<string> log) : Cabinet.Agent.Core.Services.IServicePlatform
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (string Display, ServiceState State, ServiceStartType Start)> _services = new(StringComparer.OrdinalIgnoreCase)
    {
        ["BioScanSvc"] = ("Biometric Scanner Service", ServiceState.Running, ServiceStartType.Automatic),
        ["Spooler"] = ("Print Spooler", ServiceState.Running, ServiceStartType.Automatic),
        ["MSSQL$SQLEXPRESS"] = ("SQL Server (SQLEXPRESS)", ServiceState.Running, ServiceStartType.Automatic),
        ["FlakySvc"] = ("A service that will not start", ServiceState.Stopped, ServiceStartType.Automatic),
        ["DisabledSvc"] = ("A disabled service", ServiceState.Stopped, ServiceStartType.Disabled),
        ["TermService"] = ("Remote Desktop Services", ServiceState.Stopped, ServiceStartType.Manual),
    };

    private void ApplyStops()
    {
        string file = Path.Combine(simulateDir, "stop-services.json");
        if (!File.Exists(file)) return;
        try
        {
            foreach (string name in System.Text.Json.JsonSerializer.Deserialize<string[]>(File.ReadAllText(file)) ?? [])
                if (_services.TryGetValue(name, out var s)) { _services[name] = s with { State = ServiceState.Stopped }; log($"Simulated: {name} stopped."); }
            File.Delete(file);
        }
        catch (Exception e) when (e is IOException or System.Text.Json.JsonException) { }
    }

    public IReadOnlyList<ServiceInfo> List()
    {
        lock (_gate)
        {
            ApplyStops();
            return _services.Select(kv => new ServiceInfo
            {
                Name = kv.Key, DisplayName = kv.Value.Display, State = kv.Value.State, StartType = kv.Value.Start, Account = "LocalSystem",
                ProcessId = kv.Value.State == ServiceState.Running ? 1000 + Math.Abs(kv.Key.GetHashCode() % 5000) : null,
                ExecutablePath = $"C:\\Program Files\\Simulated\\{kv.Key.Replace("$", "-")}.exe", Description = null, Recovery = null,
            }).ToList();
        }
    }

    public (ServiceState State, ServiceStartType StartType)? Query(string name)
    {
        lock (_gate) { ApplyStops(); return _services.TryGetValue(name, out var s) ? (s.State, s.Start) : null; }
    }

    public void Start(string name)
    {
        lock (_gate)
        {
            if (!_services.TryGetValue(name, out var s)) throw new Cabinet.Agent.Core.Services.ServiceControlException(1060, "No such service.");
            if (name.Equals("FlakySvc", StringComparison.OrdinalIgnoreCase)) throw new Cabinet.Agent.Core.Services.ServiceControlException(1053, "Did not respond.");
            _services[name] = s with { State = ServiceState.Running };
        }
    }

    public void Stop(string name)
    {
        lock (_gate)
        {
            if (!_services.TryGetValue(name, out var s)) throw new Cabinet.Agent.Core.Services.ServiceControlException(1060, "No such service.");
            _services[name] = s with { State = ServiceState.Stopped };
        }
    }
}
