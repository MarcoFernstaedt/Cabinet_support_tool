using System.Globalization;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Windows;

/// <summary>
/// The parts of the network read that .NET does not give: DHCP lease times, the route table and the ARP table. Each is a constant WQL
/// query; one that fails (WMI busy, a class missing) simply leaves its part out of the output instead of failing network.config.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class NetworkExtras
{
    /// <summary>When each adapter's DHCP lease was obtained and when it ends, by interface index.</summary>
    public static Dictionary<int, (DateTimeOffset? Obtained, DateTimeOffset? Expires)> Leases()
    {
        var result = new Dictionary<int, (DateTimeOffset?, DateTimeOffset?)>();
        try
        {
            foreach (var row in Wmi.Query(Wmi.CimV2, "SELECT InterfaceIndex, DHCPEnabled, DHCPLeaseObtained, DHCPLeaseExpires FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE", 128))
            {
                if (row.Long("InterfaceIndex") is not { } index || index < 1 || index > int.MaxValue) continue;
                result[(int)index] = (row.Date("DHCPLeaseObtained"), row.Date("DHCPLeaseExpires"));
            }
        }
        catch (Exception e) when (e is ManagementException or System.Runtime.InteropServices.COMException or UnauthorizedAccessException or InvalidOperationException) { }
        return result;
    }

    public sealed record AdapterExtra(int? Metric, string? AdminStatus, AdapterDriver? Driver, string? Netbios, NetworkProfile? Profile);

    private const string StandardCim = @"root\StandardCimv2";

    /// <summary>Per adapter: interface metric, admin status, driver, NetBIOS setting and the Windows network profile (Public, Private or Domain). Each part is read on its own and left out when it fails.</summary>
    public static Dictionary<int, AdapterExtra> Extras()
    {
        var metric = new Dictionary<int, int>();
        var admin = new Dictionary<int, string>();
        var driver = new Dictionary<int, AdapterDriver>();
        var netbios = new Dictionary<int, string>();
        var profile = new Dictionary<int, NetworkProfile>();
        Try(() =>
        {
            foreach (var row in Wmi.Query(StandardCim, "SELECT InterfaceIndex, AddressFamily, InterfaceMetric FROM MSFT_NetIPInterface", 256))
                if (row.Long("InterfaceIndex") is { } i && row.Long("AddressFamily") == 2 && row.Long("InterfaceMetric") is { } m && m is >= 0 and <= 9999) metric[(int)i] = (int)m;
        });
        Try(() =>
        {
            foreach (var row in Wmi.Query(StandardCim, "SELECT InterfaceIndex, InterfaceAdminStatus, DriverProvider, DriverVersionString, DriverDate FROM MSFT_NetAdapter", 128))
            {
                if (row.Long("InterfaceIndex") is not { } i) continue;
                admin[(int)i] = row.Long("InterfaceAdminStatus") switch { 1 => "up", 2 => "down", 3 => "testing", _ => "" };
                if (admin[(int)i].Length == 0) admin.Remove((int)i);
                driver[(int)i] = new AdapterDriver { Provider = Clip(row.Text("DriverProvider")), Version = Clip(row.Text("DriverVersionString")), Date = row.Date("DriverDate") };
            }
        });
        Try(() =>
        {
            foreach (var row in Wmi.Query(Wmi.CimV2, "SELECT InterfaceIndex, TcpipNetbiosOptions FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE", 128))
                if (row.Long("InterfaceIndex") is { } i && row.Long("TcpipNetbiosOptions") is { } o) netbios[(int)i] = o switch { 0 => "default", 1 => "enabled", 2 => "disabled", _ => "" };
        });
        Try(() =>
        {
            foreach (var row in Wmi.Query(StandardCim, "SELECT InterfaceIndex, Name, NetworkCategory FROM MSFT_NetConnectionProfile", 64))
                if (row.Long("InterfaceIndex") is { } i && row.Long("NetworkCategory") is { } c)
                    profile[(int)i] = new NetworkProfile { Name = Clip(row.Text("Name")), Category = c switch { 0 => "public", 1 => "private", _ => "domain" } };
        });
        var result = new Dictionary<int, AdapterExtra>();
        foreach (int i in metric.Keys.Concat(admin.Keys).Concat(driver.Keys).Concat(netbios.Keys).Concat(profile.Keys).Distinct())
            result[i] = new AdapterExtra(metric.TryGetValue(i, out int m) ? m : null, admin.GetValueOrDefault(i), driver.GetValueOrDefault(i),
                netbios.TryGetValue(i, out string? n) && n.Length > 0 ? n : null, profile.GetValueOrDefault(i));
        return result;
    }

    /// <summary>The machine-wide WinHTTP proxy from the registry. The per-user proxy belongs to a signed-in person, which this service is not, so it is reported as unknown.</summary>
    public static ProxySettings Proxy()
    {
        string? winHttp = null;
        try
        {
            using Microsoft.Win32.RegistryKey? key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\Connections");
            if (key?.GetValue("WinHttpSettings") is byte[] blob && blob.Length >= 20 && (blob[8] & 0x02) != 0)
            {
                int length = BitConverter.ToInt32(blob, 12);
                if (length is > 0 and <= 512 && 16 + length <= blob.Length) winHttp = Clip(System.Text.Encoding.ASCII.GetString(blob, 16, length));
            }
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException or ArgumentException) { }
        return new ProxySettings { WinHttp = winHttp, UserProxyEnabled = null, UserProxyServer = null };
    }

    private static string? Clip(string? text) => text is null ? null : text.Length > 200 ? text[..200] : text;

    private static void Try(Action read)
    {
        try { read(); }
        catch (Exception e) when (e is ManagementException or System.Runtime.InteropServices.COMException or UnauthorizedAccessException or InvalidOperationException) { }
    }

    /// <summary>The IPv4 routes other than loopback, multicast, broadcast and a host's own address.</summary>
    public static IReadOnlyList<RouteEntry> Routes()
    {
        var routes = new List<RouteEntry>();
        try
        {
            foreach (var row in Wmi.Query(Wmi.CimV2, "SELECT Destination, Mask, NextHop, Metric1, InterfaceIndex FROM Win32_IP4RouteTable", 512))
            {
                string? destination = row.Text("Destination"), mask = row.Text("Mask"), next = row.Text("NextHop");
                if (destination is null || mask is null || next is null || row.Long("InterfaceIndex") is not { } index || index < 1 || index > int.MaxValue) continue;
                if (!IPAddress.TryParse(destination, out IPAddress? d) || d.AddressFamily != AddressFamily.InterNetwork) continue;
                if (!IPAddress.TryParse(mask, out IPAddress? m) || m.AddressFamily != AddressFamily.InterNetwork) continue;
                int prefix = PrefixOf(m);
                byte first = d.GetAddressBytes()[0];
                if (first == 127 || first >= 224 || (prefix == 32 && next == "0.0.0.0")) continue;
                routes.Add(new RouteEntry { Destination = destination, PrefixLength = prefix, NextHop = next, Metric = row.Long("Metric1") is { } metric && metric >= 0 ? metric : 0, InterfaceIndex = (int)index });
                if (routes.Count == 128) break;
            }
        }
        catch (Exception e) when (e is ManagementException or System.Runtime.InteropServices.COMException or UnauthorizedAccessException or InvalidOperationException) { }
        return routes;
    }

    private static int PrefixOf(IPAddress mask)
    {
        int bits = 0;
        foreach (byte b in mask.GetAddressBytes()) bits += System.Numerics.BitOperations.PopCount(b);
        return bits;
    }

    /// <summary>The ARP table: which machines this cabinet has recently talked to, and whether they answer.</summary>
    public static IReadOnlyList<NeighborEntry> Neighbors()
    {
        var neighbors = new List<NeighborEntry>();
        try
        {
            foreach (var row in Wmi.Query(@"root\StandardCimv2", "SELECT InterfaceIndex, IPAddress, LinkLayerAddress, State FROM MSFT_NetNeighbor", 512))
            {
                string? address = row.Text("IPAddress");
                if (address is null || !IPAddress.TryParse(address, out IPAddress? ip) || ip.AddressFamily != AddressFamily.InterNetwork) continue;
                if (row.Long("InterfaceIndex") is not { } index || index < 1 || index > int.MaxValue) continue;
                byte first = ip.GetAddressBytes()[0];
                if (first >= 224 || first == 127) continue;
                string? mac = row.Text("LinkLayerAddress");
                neighbors.Add(new NeighborEntry
                {
                    InterfaceIndex = (int)index, Address = address, MacAddress = Mac(mac),
                    State = row.Long("State") switch { 5 or 6 => NeighborState.Reachable, 4 => NeighborState.Stale, 1 or 2 or 3 => NeighborState.Incomplete, 0 => NeighborState.Unreachable, _ => NeighborState.Other },
                });
                if (neighbors.Count == 64) break;
            }
        }
        catch (Exception e) when (e is ManagementException or System.Runtime.InteropServices.COMException or UnauthorizedAccessException or InvalidOperationException) { }
        return neighbors;
    }

    /// <summary>The MAC address in the contract's form (AA-BB-CC-DD-EE-FF), or null if it is not six bytes.</summary>
    private static string? Mac(string? raw)
    {
        if (raw is null) return null;
        string hex = raw.Replace("-", "", StringComparison.Ordinal).Replace(":", "", StringComparison.Ordinal);
        if (hex.Length != 12 || !hex.All(Uri.IsHexDigit)) return null;
        return string.Join('-', Enumerable.Range(0, 6).Select(i => hex.Substring(i * 2, 2).ToUpper(CultureInfo.InvariantCulture)));
    }
}
