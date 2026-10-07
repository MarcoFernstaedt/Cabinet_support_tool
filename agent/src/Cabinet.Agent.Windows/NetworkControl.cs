using System.Management;
using System.Net;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Writes;

namespace Cabinet.Agent.Windows;

/// <summary>One adapter's IPv4 and DNS settings through the Windows management interface (Win32_NetworkAdapterConfiguration).</summary>
[SupportedOSPlatform("windows")]
public sealed class NetworkControl : INetworkControl
{
    private static ManagementObject Adapter(int interfaceIndex)
    {
        // The index is an integer from a validated command, so it is safe in the query text.
        using var searcher = new ManagementObjectSearcher(Wmi.CimV2, $"SELECT * FROM Win32_NetworkAdapterConfiguration WHERE InterfaceIndex = {interfaceIndex}");
        ManagementObject? found = searcher.Get().OfType<ManagementObject>().FirstOrDefault();
        if (found is null || found["IPEnabled"] is not true) throw new OperationFailedException("not_found", "No IP-enabled adapter has that interface index.");
        return found;
    }

    public (Ipv4Settings Ip, DnsSettings Dns) Read(int interfaceIndex)
    {
        using ManagementObject a = Adapter(interfaceIndex);
        var addresses = new List<Ipv4Address>();
        string[] ips = a["IPAddress"] as string[] ?? [];
        string[] masks = a["IPSubnet"] as string[] ?? [];
        for (int i = 0; i < ips.Length && addresses.Count < 16; i++)
            if (IPAddress.TryParse(ips[i], out IPAddress? ip) && ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && i < masks.Length && Prefix(masks[i]) is int prefix)
                addresses.Add(new Ipv4Address { Address = ip.ToString(), PrefixLength = prefix });
        var gateways = (a["DefaultIPGateway"] as string[] ?? []).Where(g => IPAddress.TryParse(g, out IPAddress? x) && x.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork).Take(8).ToList();
        var dns = (a["DNSServerSearchOrder"] as string[] ?? []).Where(g => IPAddress.TryParse(g, out IPAddress? x) && x.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork).Take(4).ToList();
        string settingId = a["SettingID"] as string ?? "";
        return (new Ipv4Settings { Dhcp = a["DHCPEnabled"] is true, Addresses = addresses, Gateways = gateways },
                new DnsSettings { Automatic = !SystemOperations.HasStaticDns(settingId), Servers = dns });
    }

    private static int? Prefix(string mask)
    {
        if (!IPAddress.TryParse(mask, out IPAddress? m) || m.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return null;
        uint bits = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(m.GetAddressBytes());
        int prefix = System.Numerics.BitOperations.PopCount(bits);
        return bits == (prefix == 0 ? 0u : uint.MaxValue << (32 - prefix)) ? prefix : null;
    }

    private static string Mask(int prefix)
    {
        byte[] bytes = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes, prefix == 0 ? 0u : uint.MaxValue << (32 - prefix));
        return new IPAddress(bytes).ToString();
    }

    private static void Invoke(ManagementObject a, string method, Action<ManagementBaseObject>? fill = null)
    {
        ManagementBaseObject? input = fill is null ? null : a.GetMethodParameters(method);
        if (input is not null) fill!(input);
        using ManagementBaseObject output = a.InvokeMethod(method, input, null);
        uint code = Convert.ToUInt32(output["ReturnValue"], System.Globalization.CultureInfo.InvariantCulture);
        if (code is not 0 and not 1) throw new OperationFailedException("execution_failed", $"Windows refused the network change ({method} returned {code}).");
    }

    public void SetDhcp(int interfaceIndex)
    {
        using ManagementObject a = Adapter(interfaceIndex);
        Invoke(a, "EnableDHCP");
    }

    public void SetStatic(int interfaceIndex, string address, int prefixLength, string gateway)
    {
        using ManagementObject a = Adapter(interfaceIndex);
        Invoke(a, "EnableStatic", p => { p["IPAddress"] = new[] { address }; p["SubnetMask"] = new[] { Mask(prefixLength) }; });
        Invoke(a, "SetGateways", p => { p["DefaultIPGateway"] = new[] { gateway }; p["GatewayCostMetric"] = new ushort[] { 1 }; });
    }

    public void SetDns(int interfaceIndex, DnsSettings dns)
    {
        using ManagementObject a = Adapter(interfaceIndex);
        Invoke(a, "SetDNSServerSearchOrder", p => p["DNSServerSearchOrder"] = dns.Automatic ? null : dns.Servers.ToArray());
    }

    public void Restore(int interfaceIndex, Ipv4Settings ip)
    {
        using ManagementObject a = Adapter(interfaceIndex);
        if (ip.Dhcp || ip.Addresses.Count == 0) { Invoke(a, "EnableDHCP"); return; }
        Invoke(a, "EnableStatic", p => { p["IPAddress"] = ip.Addresses.Select(x => x.Address).ToArray(); p["SubnetMask"] = ip.Addresses.Select(x => Mask(x.PrefixLength)).ToArray(); });
        if (ip.Gateways.Count > 0)
            Invoke(a, "SetGateways", p => { p["DefaultIPGateway"] = ip.Gateways.ToArray(); p["GatewayCostMetric"] = ip.Gateways.Select(_ => (ushort)1).ToArray(); });
    }
}
