using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Cabinet.Agent.Core;

/// <summary>One IPv4 network this cabinet is directly connected to.</summary>
public sealed record LocalNetwork(IPAddress Address, int PrefixLength)
{
    public static IReadOnlyList<LocalNetwork> Current() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
            .Select(a => new LocalNetwork(a.Address, a.PrefixLength))
            .ToList();

    /// <summary>RFC 1918 private ranges: 10/8, 172.16/12, 192.168/16.</summary>
    public static bool IsPrivate(IPAddress ip)
    {
        byte[] b = ip.GetAddressBytes();
        return b.Length == 4 && (b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168));
    }

    public bool Contains(IPAddress ip)
    {
        if (ip.AddressFamily != AddressFamily.InterNetwork || PrefixLength is < 8 or > 32) return false;
        uint mask = PrefixLength == 32 ? uint.MaxValue : ~(uint.MaxValue >> PrefixLength);
        return (ToUInt(ip) & mask) == (ToUInt(Address) & mask);
    }

    /// <summary>
    /// A private IPv4 address inside one of the given networks, and not this cabinet's own
    /// address, the network address or the broadcast address. Networks wider than /16 do not
    /// count, so a mis-set huge prefix cannot widen what the server may reach.
    /// </summary>
    public static bool IsPrivateOnLocalNetwork(string address, IReadOnlyList<LocalNetwork> networks)
    {
        if (!IPAddress.TryParse(address, out IPAddress? ip) || ip.AddressFamily != AddressFamily.InterNetwork || !IsPrivate(ip)) return false;
        foreach (LocalNetwork n in networks)
        {
            if (n.PrefixLength is < 16 or > 30 || !n.Contains(ip) || ip.Equals(n.Address)) continue;
            uint host = ToUInt(ip) & (n.PrefixLength == 32 ? 0 : uint.MaxValue >> n.PrefixLength);
            uint hostMask = uint.MaxValue >> n.PrefixLength;
            if (host == 0 || host == hostMask) continue;
            return true;
        }
        return false;
    }

    private static uint ToUInt(IPAddress ip)
    {
        byte[] b = ip.GetAddressBytes();
        return (uint)(b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]);
    }
}
