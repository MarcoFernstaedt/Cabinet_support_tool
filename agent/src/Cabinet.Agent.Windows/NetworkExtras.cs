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
