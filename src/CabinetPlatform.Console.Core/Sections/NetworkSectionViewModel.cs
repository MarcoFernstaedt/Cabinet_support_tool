using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// Adapters, addressing, firewall profiles and proxy configuration, plus the
/// two network actions.
/// </summary>
/// <remarks>
/// The readings arrive on the cabinet's inventory check-in rather than on every
/// heartbeat: an adapter's address is configuration, and re-sending it every
/// five minutes from seven thousand cabinets would cost far more than it tells
/// anyone. The actions — flush DNS, renew the DHCP lease — are exactly what an
/// engineer reaches for on a cabinet that has stopped resolving the platform
/// host, so they sit here beside the readings they would change.
/// </remarks>
public sealed partial class NetworkSectionViewModel : MachineSectionViewModel
{
    /// <summary>Creates the section.</summary>
    public NetworkSectionViewModel()
        : base("Network",
            "Adapters, IP addresses, DNS, gateway, proxy and firewall profiles, from the " +
            "cabinet's most recent inventory check-in. Flush DNS cache and renew DHCP lease " +
            "actions are inside this section.")
    {
    }

    /// <summary>Adapters as the cabinet last reported them.</summary>
    public ObservableCollection<NetworkAdapterInfo> Adapters { get; } = new();

    /// <summary>Whether a proxy is configured for outbound traffic.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private StatusPresentation _proxy = StatusPresentation.Unknown;

    /// <summary>Configured proxy address, when there is one.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _proxyAddress = Format.NotReported;

    /// <summary>Windows Firewall domain profile.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private StatusPresentation _firewallDomain = StatusPresentation.Unknown;

    /// <summary>Windows Firewall private profile.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private StatusPresentation _firewallPrivate = StatusPresentation.Unknown;

    /// <summary>Windows Firewall public profile.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private StatusPresentation _firewallPublic = StatusPresentation.Unknown;

    /// <summary>Whether the cabinet could reach the platform server.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private StatusPresentation _serverReachable = StatusPresentation.Unknown;

    /// <inheritdoc />
    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        Adapters.Clear();

        NetworkInfo? network = latest?.CurrentInventory?.Network;

        if (network is null)
        {
            Availability = latest?.CurrentInventory is null
                ? SectionAvailability.NoInventoryYet(Title)
                : SectionAvailability.CollectorFailed(Title);

            Proxy = StatusPresentation.Unknown;
            FirewallDomain = StatusPresentation.Unknown;
            FirewallPrivate = StatusPresentation.Unknown;
            FirewallPublic = StatusPresentation.Unknown;
            ServerReachable = StatusPresentation.Unknown;
            ProxyAddress = Format.NotReported;
            return;
        }

        Availability = SectionAvailability.Available;

        foreach (NetworkAdapterInfo adapter in network.Adapters ?? Array.Empty<NetworkAdapterInfo>())
        {
            Adapters.Add(adapter);
        }

        Proxy = StatusPresentation.ForBoolean(network.ProxyConfigured, "Configured", "None");
        ProxyAddress = Format.Text(network.ProxyAddress);
        FirewallDomain = StatusPresentation.ForBoolean(network.FirewallDomainEnabled, "On", "Off");
        FirewallPrivate = StatusPresentation.ForBoolean(network.FirewallPrivateEnabled, "On", "Off");
        FirewallPublic = StatusPresentation.ForBoolean(network.FirewallPublicEnabled, "On", "Off");
        ServerReachable = StatusPresentation.ForBoolean(
            network.ServerReachable, "Reachable", "Unreachable");

        _ = nowUtc;
    }

    /// <inheritdoc />
    public override string Summarise() =>
        Availability.HasData
            ? $"Network: {Adapters.Count} adapter(s). Proxy {Proxy.Label}. " +
              $"Platform server {ServerReachable.Label}."
            : $"Network: {Availability.Reason}";
}
