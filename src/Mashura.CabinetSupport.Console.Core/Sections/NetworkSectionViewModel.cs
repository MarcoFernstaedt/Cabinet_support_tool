using Mashura.CabinetSupport.Console.Core.Presentation;

namespace Mashura.CabinetSupport.Console.Core.Sections;

/// <summary>
/// Adapters, addressing, firewall profiles and reachability — plus the two
/// network actions, which do work.
/// </summary>
/// <remarks>
/// The data half of this section is not carried by this server's check-in
/// contract. The action half is fully supported: flushing DNS and renewing a
/// DHCP lease are both in the server's catalogue, and they are exactly what an
/// engineer reaches for on a cabinet that has stopped resolving the platform
/// host. So the section shows the gap in the data and offers the actions anyway,
/// rather than hiding two working remedies behind a missing diagnostic.
/// </remarks>
public sealed class NetworkSectionViewModel : UnservedSectionViewModel
{
    public NetworkSectionViewModel()
        : base("Network",
            "Adapters, IP addresses, DNS, gateway, proxy, firewall profiles and server " +
            "reachability. Not carried by this server build. Flush DNS cache and renew " +
            "DHCP lease actions are inside this section and do work.")
    {
    }

    /// <summary>
    /// Says that the actions work even though the readings do not, so nobody
    /// concludes the whole section is inert.
    /// </summary>
    public string ActionsStillWorkNote =>
        "The actions below are fully supported by the server and will run on the cabinet. " +
        "Only the network readings above are missing.";
}
