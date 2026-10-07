using System.Collections;
using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Cabinet.Agent.Core.Writes;
using Microsoft.Win32;

namespace Cabinet.Agent.Windows;

/// <summary>system.info, network.config and firewall.state (network process), and updates.status (broker: Windows Update refuses the restricted network account).</summary>
[SupportedOSPlatform("windows")]
public sealed class SystemOperations(AgentConfig config)
{
    public static string AgentVersion { get; } =
        typeof(SystemOperations).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";

    public Task<SystemInfoOutput> SystemInfoAsync(EmptyParams _, CancellationToken token)
    {
        using RegistryKey? nt = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        string build = nt?.GetValue("CurrentBuild") as string ?? Environment.OSVersion.Version.Build.ToString(CultureInfo.InvariantCulture);
        string product = nt?.GetValue("ProductName") as string ?? "Windows";
        // ProductName still says "Windows 10" on Windows 11 builds.
        if (int.TryParse(build, NumberStyles.None, CultureInfo.InvariantCulture, out int number) && number >= 22000)
            product = product.Replace("Windows 10", "Windows 11", StringComparison.Ordinal);
        string? display = nt?.GetValue("DisplayVersion") as string;
        string ubr = nt?.GetValue("UBR") is int u ? "." + u.ToString(CultureInfo.InvariantCulture) : "";

        string? serial = null;
        try
        {
            serial = Wmi.Query(Wmi.CimV2, "SELECT SerialNumber FROM Win32_BIOS").FirstOrDefault()?.Text("SerialNumber");
            if (serial is not null && (serial.Contains("O.E.M.", StringComparison.OrdinalIgnoreCase) || serial.Equals("Default string", StringComparison.OrdinalIgnoreCase))) serial = null;
        }
        catch (Exception e) when (e is System.Management.ManagementException or UnauthorizedAccessException) { }

        return Task.FromResult(new SystemInfoOutput
        {
            Hostname = Hostname(Environment.MachineName),
            OsVersion = EventText.ShortText(display is null ? product : $"{product} {display}"),
            OsBuild = EventText.ShortText(build + ubr),
            UptimeSeconds = Environment.TickCount64 / 1000,
            AgentVersion = AgentVersion,
            ReadOnlyMode = config.ReadOnlyMode,
            CabinetRole = config.CabinetRole,
            SerialNumber = serial is null ? null : EventText.ShortText(serial),
        });
    }

    /// <summary>A computer name in the contract's host-name characters; anything else becomes a hyphen.</summary>
    internal static string Hostname(string name)
    {
        string cleaned = new(name.Select(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' ? c : '-').ToArray());
        cleaned = cleaned.Trim('-', '.');
        return cleaned.Length is > 0 and <= 63 ? cleaned : "unknown-host";
    }

    /// <summary>Windows Update history and pending updates from the Windows Update Agent, using its cached search (no download).</summary>
    public static Task<UpdatesStatusOutput> UpdatesStatusAsync(EmptyParams _, CancellationToken token)
    {
        object? session = null;
        try
        {
            Type type = Type.GetTypeFromProgID("Microsoft.Update.Session", throwOnError: false)
                ?? throw new OperationFailedException("unavailable", "Windows Update is not available on this cabinet.");
            session = Activator.CreateInstance(type);
            dynamic s = session!;
            dynamic searcher = s.CreateUpdateSearcher();
            searcher.Online = false;

            var installed = new List<InstalledUpdate>();
            int count = searcher.GetTotalHistoryCount();
            if (count > 0)
            {
                dynamic history = searcher.QueryHistory(0, Math.Min(count, 500));
                foreach (dynamic entry in (IEnumerable)history)
                {
                    token.ThrowIfCancellationRequested();
                    if ((int)entry.Operation != 1) continue; // installations only
                    string title = EventText.ShortText((string?)entry.Title);
                    if (title.Length == 0) continue;
                    int hresult = (int)entry.HResult;
                    installed.Add(new InstalledUpdate
                    {
                        Title = title, Kb = Kb(title),
                        InstalledAt = entry.Date is DateTime d ? new DateTimeOffset(DateTime.SpecifyKind(d, DateTimeKind.Utc)) : null,
                        Result = Result((int)entry.ResultCode), ErrorCode = hresult == 0 ? null : hresult,
                    });
                }
            }

            var pending = new List<PendingUpdate>();
            dynamic result = searcher.Search("IsInstalled=0 and IsHidden=0");
            foreach (dynamic update in (IEnumerable)result.Updates)
            {
                if (pending.Count == 500) break;
                string title = EventText.ShortText((string?)update.Title);
                if (title.Length == 0) continue;
                string? classification = null;
                foreach (dynamic category in (IEnumerable)update.Categories)
                    if ((string?)category.Type == "UpdateClassification") { classification = EventText.ShortText((string?)category.Name); break; }
                string? severity = update.MsrcSeverity as string;
                pending.Add(new PendingUpdate
                {
                    Title = title, Kb = Kb(title), Classification = classification,
                    IsSecurity = !string.IsNullOrEmpty(severity) || string.Equals(classification, "Security Updates", StringComparison.OrdinalIgnoreCase),
                });
            }

            DateTimeOffset? lastCheck = null, lastInstall = null;
            try
            {
                dynamic auto = Activator.CreateInstance(Type.GetTypeFromProgID("Microsoft.Update.AutoUpdate", throwOnError: true)!)!;
                dynamic results = auto.Results;
                if (results.LastSearchSuccessDate is DateTime c) lastCheck = new DateTimeOffset(DateTime.SpecifyKind(c, DateTimeKind.Utc));
                if (results.LastInstallationSuccessDate is DateTime i) lastInstall = new DateTimeOffset(DateTime.SpecifyKind(i, DateTimeKind.Utc));
            }
            catch (COMException) { }

            var newest = installed.Where(i => i.InstalledAt is not null).MaxBy(i => i.InstalledAt);
            return Task.FromResult(new UpdatesStatusOutput
            {
                LastCheckAt = lastCheck, LastInstallAt = lastInstall ?? newest?.InstalledAt, LastInstallResult = newest?.Result,
                Installed = installed, Pending = pending,
            });
        }
        catch (COMException)
        {
            throw new OperationFailedException("unavailable", "The Windows Update service did not answer.");
        }
        finally
        {
            if (session is not null && Marshal.IsComObject(session)) Marshal.FinalReleaseComObject(session);
        }
    }

    private static UpdateResult Result(int code) => code switch
    {
        1 => UpdateResult.InProgress, 2 => UpdateResult.Succeeded, 3 => UpdateResult.SucceededWithErrors,
        4 => UpdateResult.Failed, 5 => UpdateResult.Aborted, _ => UpdateResult.Unknown,
    };

    /// <summary>"KB5034441" from an update title, found by scanning for "KB" followed by digits.</summary>
    internal static string? Kb(string title)
    {
        for (int i = title.IndexOf("KB", StringComparison.Ordinal); i >= 0; i = title.IndexOf("KB", i + 2, StringComparison.Ordinal))
        {
            int end = i + 2;
            while (end < title.Length && char.IsAsciiDigit(title[end])) end++;
            if (end - i - 2 is >= 5 and <= 8) return title[i..end];
        }
        return null;
    }

    public Task<NetworkConfigOutput> NetworkConfigAsync(EmptyParams _, CancellationToken token)
    {
        var adapters = new List<NetworkAdapter>();
        foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (adapters.Count == 64) break;
            if (nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;
            IPInterfaceProperties props = nic.GetIPProperties();
            IPv4InterfaceProperties? v4;
            try { v4 = props.GetIPv4Properties(); }
            catch (NetworkInformationException) { continue; }
            if (v4 is null || v4.Index < 1) continue;

            byte[] mac = nic.GetPhysicalAddress().GetAddressBytes();
            var dnsServers = props.DnsAddresses.Where(a => a.AddressFamily == AddressFamily.InterNetwork).Select(a => a.ToString()).Distinct().Take(4).ToList();
            adapters.Add(new NetworkAdapter
            {
                InterfaceIndex = v4.Index,
                Name = EventText.ShortText(nic.Name),
                Description = nic.Description is { Length: > 0 } d ? EventText.ShortText(d) : null,
                Type = nic.NetworkInterfaceType switch
                {
                    NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetT => AdapterType.Ethernet,
                    NetworkInterfaceType.Wireless80211 => AdapterType.Wifi,
                    _ => AdapterType.Other,
                },
                Connected = nic.OperationalStatus == OperationalStatus.Up,
                LinkSpeedBps = nic.Speed > 0 ? nic.Speed : null,
                MacAddress = mac.Length == 6 ? string.Join('-', mac.Select(b => b.ToString("X2", CultureInfo.InvariantCulture))) : null,
                Ipv4 = new Ipv4Settings
                {
                    Dhcp = v4.IsDhcpEnabled,
                    Addresses = props.UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
                        .Select(a => new Ipv4Address { Address = a.Address.ToString(), PrefixLength = a.PrefixLength }).Take(16).ToList(),
                    Gateways = props.GatewayAddresses.Select(g => g.Address).Where(a => a.AddressFamily == AddressFamily.InterNetwork && !a.Equals(IPAddress.Any))
                        .Select(a => a.ToString()).Distinct().Take(8).ToList(),
                },
                Ipv6Addresses = props.UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetworkV6)
                    .Select(a => a.Address.ToString()).Where(a => a.Length <= 45).Take(16).ToList(),
                Dns = new DnsSettings { Automatic = !HasStaticDns(nic.Id), Servers = dnsServers },
                DnsSuffix = props.DnsSuffix is { Length: > 0 } suffix ? EventText.ShortText(suffix) : null,
            });
        }
        return Task.FromResult(new NetworkConfigOutput { Adapters = adapters });
    }

    /// <summary>DNS servers typed in by hand are stored as NameServer on the interface; DHCP-supplied ones are not.</summary>
    internal static bool HasStaticDns(string interfaceId)
    {
        if (!Guid.TryParse(interfaceId, out Guid id)) return false;
        try
        {
            using RegistryKey? key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{id:B}");
            return key?.GetValue("NameServer") is string s && s.Trim().Length > 0;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return false; }
    }

    /// <summary>
    /// Firewall profiles and every rule, read through the Windows Firewall policy object, with the snapshots
    /// the broker saved and any timer that will turn a profile back on (read from the broker's folder).
    /// </summary>
    public Task<FirewallStateOutput> FirewallStateAsync(EmptyParams _, CancellationToken token)
    {
        FirewallStateOutput state = FirewallCom.Read(token);
        var store = new FirewallStore(AgentPaths.BrokerFirewall);
        IReadOnlyList<FirewallStore.Timer> timers;
        IReadOnlyList<FirewallSnapshotInfo> snapshots;
        try { timers = store.TimersList(); snapshots = store.Snapshots(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { timers = []; snapshots = []; }
        return Task.FromResult(state with
        {
            Profiles = state.Profiles.Select(p => p with { ReenableAt = timers.FirstOrDefault(t => t.Profile == p.Profile)?.ReenableAt }).ToList(),
            Snapshots = snapshots.Take(20).ToList(),
        });
    }
}

/// <summary>Everything the network process can run. Broker operations are forwarded over the locked pipe.</summary>
[SupportedOSPlatform("windows")]
public static class NetworkOperations
{
    /// <param name="packages">Downloads packages for package.install before the broker checks and installs them.</param>
    public static OperationRegistry Registry(AgentConfig config, BrokerClient broker, TimeProvider clock, Core.Packages.PackageDownloads? packages = null)
    {
        var system = new SystemOperations(config);
        var devices = new DeviceOperations(config, broker, clock);
        var network = new NetworkTester(config);
        var registry = new OperationRegistry()
            .Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo, system.SystemInfoAsync)
            .Register<DevicesListParams, DevicesListOutput>(Catalog.DevicesList, devices.DevicesListAsync)
            .Register<EmptyParams, DriversListOutput>(Catalog.DriversList, devices.DriversListAsync)
            .Register<PeripheralStatusParams, PeripheralStatusOutput>(Catalog.PeripheralStatus, devices.PeripheralStatusAsync)
            .Register<EmptyParams, NetworkConfigOutput>(Catalog.NetworkConfig, system.NetworkConfigAsync)
            .Register<NetworkTestParams, NetworkTestOutput>(Catalog.NetworkTest, network.RunAsync)
            .Register<EmptyParams, FirewallStateOutput>(Catalog.FirewallState, system.FirewallStateAsync);
        packages?.Register(registry, broker.RunAsync);
        broker.RegisterForwarders(registry);
        return registry;
    }
}
