using System.Net.NetworkInformation;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Enumerates network adapters. Abstracted so the collector can be tested
/// against fixed adapter sets.
/// </summary>
public interface INetworkInterfaceProvider
{
    IReadOnlyList<NetworkAdapterInfo> GetAdapters();
}

/// <summary>
/// Reads adapters through <see cref="NetworkInterface"/>.
/// </summary>
public sealed class NetworkInterfaceProvider : INetworkInterfaceProvider
{
    public IReadOnlyList<NetworkAdapterInfo> GetAdapters()
    {
        var adapters = new List<NetworkAdapterInfo>();

        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            // The loopback and tunnel pseudo-adapters are on every machine and
            // tell support nothing about why a cabinet is offline.
            if (adapter.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
            {
                continue;
            }

            adapters.Add(Describe(adapter));
        }

        return adapters;
    }

    private static NetworkAdapterInfo Describe(NetworkInterface adapter)
    {
        var addresses = new List<string>();
        var masks = new List<string>();
        var gateways = new List<string>();
        var dnsServers = new List<string>();
        bool? dhcpEnabled = null;

        try
        {
            var properties = adapter.GetIPProperties();

            foreach (var unicast in properties.UnicastAddresses)
            {
                addresses.Add(unicast.Address.ToString());

                // A subnet mask only exists for IPv4; IPv6 uses prefix lengths.
                if (unicast.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                {
                    masks.Add(unicast.IPv4Mask.ToString());
                }
            }

            gateways.AddRange(properties.GatewayAddresses.Select(gateway => gateway.Address.ToString()));
            dnsServers.AddRange(properties.DnsAddresses.Select(dns => dns.ToString()));

            // IPv4 properties are absent on an adapter with IPv6 only, which is
            // not an error and not a reason to lose the rest of the adapter.
            try
            {
                dhcpEnabled = properties.GetIPv4Properties()?.IsDhcpEnabled;
            }
            catch (NetworkInformationException)
            {
                dhcpEnabled = null;
            }
        }
        catch (NetworkInformationException)
        {
            // An adapter being torn down mid-enumeration still gets reported
            // with its name and status, which is the part that matters.
        }

        return new NetworkAdapterInfo
        {
            Name = adapter.Name,
            Description = adapter.Description,
            MacAddress = FormatMacAddress(adapter),
            Status = MapStatus(adapter.OperationalStatus),
            LinkSpeedBps = TryReadSpeed(adapter),
            IpAddresses = addresses,
            SubnetMasks = masks,
            Gateways = gateways,
            DnsServers = dnsServers,
            DhcpEnabled = dhcpEnabled,
        };
    }

    private static string? FormatMacAddress(NetworkInterface adapter)
    {
        var bytes = adapter.GetPhysicalAddress().GetAddressBytes();
        return bytes.Length == 0 ? null : string.Join(":", bytes.Select(b => b.ToString("X2")));
    }

    private static long? TryReadSpeed(NetworkInterface adapter)
    {
        try
        {
            // A down adapter reports -1 rather than throwing.
            return adapter.Speed >= 0 ? adapter.Speed : null;
        }
        catch (Exception e) when (e is NetworkInformationException or PlatformNotSupportedException)
        {
            return null;
        }
    }

    internal static NetworkAdapterStatus MapStatus(OperationalStatus status) => status switch
    {
        OperationalStatus.Up => NetworkAdapterStatus.Up,
        OperationalStatus.Down => NetworkAdapterStatus.Down,
        OperationalStatus.Testing => NetworkAdapterStatus.Testing,
        OperationalStatus.Dormant => NetworkAdapterStatus.Dormant,
        OperationalStatus.NotPresent => NetworkAdapterStatus.NotPresent,
        OperationalStatus.LowerLayerDown => NetworkAdapterStatus.LowerLayerDown,
        _ => NetworkAdapterStatus.Unknown,
    };
}
