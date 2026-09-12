using System.Runtime.Versioning;
using CabinetPlatform.Agent.Platform.Wmi;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// One adapter's IP configuration, as it stands.
/// </summary>
/// <remarks>
/// This is what gets written to disk before a change and put back if the
/// cabinet then cannot reach the server. Every field is what was actually read,
/// not what was assumed: an adapter with no gateway really has no gateway, and
/// restoring an invented one would be worse than not restoring at all.
/// </remarks>
public sealed record AdapterConfiguration
{
    /// <summary>The adapter's stable Windows settings identifier.</summary>
    public required string AdapterId { get; init; }

    /// <summary>Its friendly name, for a person reading a result.</summary>
    public string? AdapterName { get; init; }

    /// <summary>Whether it takes its address from DHCP.</summary>
    public required bool DhcpEnabled { get; init; }

    /// <summary>Its IPv4 addresses.</summary>
    public IReadOnlyList<string> IpAddresses { get; init; } = Array.Empty<string>();

    /// <summary>Their subnet masks, in the same order.</summary>
    public IReadOnlyList<string> SubnetMasks { get; init; } = Array.Empty<string>();

    /// <summary>Its default gateways.</summary>
    public IReadOnlyList<string> Gateways { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Its DNS servers, or null when they are not configured on the adapter at
    /// all.
    /// </summary>
    /// <remarks>
    /// Null and empty are different states and are kept different. An adapter
    /// with no adapter-level DNS servers inherits the machine's; one with an
    /// empty list has been explicitly given none. Restoring the wrong one of
    /// those leaves a cabinet that resolves nothing.
    /// </remarks>
    public IReadOnlyList<string>? DnsServers { get; init; }
}

/// <summary>
/// Changing a cabinet's IP configuration.
/// </summary>
/// <remarks>
/// Through <c>Win32_NetworkAdapterConfiguration</c>'s own methods, never
/// through <c>netsh</c>. That is not a style preference: shelling out would
/// give the agent a general mechanism for launching programs with arguments,
/// and the agent's safety rests on not having one.
/// </remarks>
public interface INetworkConfigurationGateway
{
    /// <summary>Reads one adapter's current configuration.</summary>
    /// <param name="adapterId">The adapter's settings identifier.</param>
    AdapterConfiguration? Read(string adapterId);

    /// <summary>Replaces an adapter's DNS servers.</summary>
    /// <param name="adapterId">The adapter's settings identifier.</param>
    /// <param name="dnsServers">The servers to set, in order of preference.</param>
    void SetDnsServers(string adapterId, IReadOnlyList<string> dnsServers);

    /// <summary>Gives an adapter a static address.</summary>
    /// <param name="adapterId">The adapter's settings identifier.</param>
    /// <param name="ipAddress">The address.</param>
    /// <param name="subnetMask">Its mask.</param>
    /// <param name="defaultGateway">The gateway, or null to leave it alone.</param>
    void SetStaticAddress(
        string adapterId, string ipAddress, string subnetMask, string? defaultGateway);

    /// <summary>Returns an adapter to DHCP.</summary>
    /// <param name="adapterId">The adapter's settings identifier.</param>
    void EnableDhcp(string adapterId);

    /// <summary>
    /// Puts a previously read configuration back.
    /// </summary>
    /// <remarks>
    /// The rollback path, and the one that has to work when everything else has
    /// not. It restores whichever shape the adapter was in — DHCP or static —
    /// rather than assuming one.
    /// </remarks>
    /// <param name="configuration">The configuration to restore.</param>
    void Restore(AdapterConfiguration configuration);
}

/// <summary>
/// Drives <c>Win32_NetworkAdapterConfiguration</c> through WMI.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class NetworkConfigurationGateway : INetworkConfigurationGateway
{
    private readonly IWmiRepository _wmi;

    /// <summary>Creates the gateway.</summary>
    /// <param name="wmi">The WMI surface.</param>
    public NetworkConfigurationGateway(IWmiRepository wmi) => _wmi = wmi;

    /// <inheritdoc />
    public AdapterConfiguration? Read(string adapterId)
    {
        IReadOnlyList<WmiRecord> rows = _wmi.Query(WmiScopes.CimV2, QueryFor(adapterId));

        if (rows.Count == 0)
        {
            return null;
        }

        WmiRecord row = rows[0];

        return new AdapterConfiguration
        {
            AdapterId = adapterId,
            AdapterName = row.GetString("Description"),
            DhcpEnabled = row.GetBoolean("DHCPEnabled") ?? false,
            IpAddresses = OnlyIpv4(row.GetStringArray("IPAddress")),
            SubnetMasks = row.GetStringArray("IPSubnet") ?? Array.Empty<string>(),
            Gateways = OnlyIpv4(row.GetStringArray("DefaultIPGateway")),
            DnsServers = row.GetStringArray("DNSServerSearchOrder"),
        };
    }

    /// <inheritdoc />
    public void SetDnsServers(string adapterId, IReadOnlyList<string> dnsServers) =>
        Invoke(
            adapterId,
            "SetDNSServerSearchOrder",
            new Dictionary<string, object?> { ["DNSServerSearchOrder"] = dnsServers.ToArray() });

    /// <inheritdoc />
    public void SetStaticAddress(
        string adapterId, string ipAddress, string subnetMask, string? defaultGateway)
    {
        Invoke(
            adapterId,
            "EnableStatic",
            new Dictionary<string, object?>
            {
                ["IPAddress"] = new[] { ipAddress },
                ["SubnetMask"] = new[] { subnetMask },
            });

        if (!string.IsNullOrWhiteSpace(defaultGateway))
        {
            Invoke(
                adapterId,
                "SetGateways",
                new Dictionary<string, object?>
                {
                    ["DefaultIPGateway"] = new[] { defaultGateway },

                    // One metric per gateway, as the method requires. A single
                    // gateway at metric 1 is what a cabinet has.
                    ["GatewayCostMetric"] = new[] { 1 },
                });
        }
    }

    /// <inheritdoc />
    public void EnableDhcp(string adapterId)
    {
        Invoke(adapterId, "EnableDHCP", parameters: null);

        // Clearing the adapter's DNS servers is part of returning to DHCP: an
        // adapter left with static DNS after EnableDHCP resolves against
        // whatever the previous network used, which is the subtlest way to
        // leave a cabinet half-moved.
        Invoke(
            adapterId,
            "SetDNSServerSearchOrder",
            new Dictionary<string, object?> { ["DNSServerSearchOrder"] = null });
    }

    /// <inheritdoc />
    public void Restore(AdapterConfiguration configuration)
    {
        if (configuration.DhcpEnabled)
        {
            Invoke(configuration.AdapterId, "EnableDHCP", parameters: null);
        }
        else if (configuration.IpAddresses.Count > 0 && configuration.SubnetMasks.Count > 0)
        {
            Invoke(
                configuration.AdapterId,
                "EnableStatic",
                new Dictionary<string, object?>
                {
                    ["IPAddress"] = configuration.IpAddresses.ToArray(),
                    ["SubnetMask"] = configuration.SubnetMasks.ToArray(),
                });

            if (configuration.Gateways.Count > 0)
            {
                Invoke(
                    configuration.AdapterId,
                    "SetGateways",
                    new Dictionary<string, object?>
                    {
                        ["DefaultIPGateway"] = configuration.Gateways.ToArray(),
                        ["GatewayCostMetric"] = configuration.Gateways.Select(_ => 1).ToArray(),
                    });
            }
        }

        // Null means the adapter had no adapter-level DNS servers and inherited
        // the machine's. Restoring an empty array instead would leave it
        // explicitly configured with none, which resolves nothing.
        Invoke(
            configuration.AdapterId,
            "SetDNSServerSearchOrder",
            new Dictionary<string, object?>
            {
                ["DNSServerSearchOrder"] = configuration.DnsServers?.ToArray(),
            });
    }

    /// <summary>
    /// The WQL that selects one adapter, by its settings identifier.
    /// </summary>
    /// <remarks>
    /// The identifier is a GUID in braces on every Windows machine, and is
    /// checked as one before it is put into the query. It has already passed
    /// the server's validation; this is the last point at which a value
    /// carrying a quote could matter, and checking again costs nothing.
    /// </remarks>
    private static string QueryFor(string adapterId)
    {
        if (!IsSimpleSettingId(adapterId))
        {
            throw new ArgumentException(
                "The adapter identifier is not a Windows adapter settings id.", nameof(adapterId));
        }

        return $"SELECT * FROM Win32_NetworkAdapterConfiguration WHERE SettingID = '{adapterId}'";
    }

    private static bool IsSimpleSettingId(string adapterId) =>
        !string.IsNullOrWhiteSpace(adapterId) &&
        adapterId.Length <= 64 &&
        adapterId.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '{' or '}');

    private void Invoke(
        string adapterId, string method, IReadOnlyDictionary<string, object?>? parameters)
    {
        IReadOnlyList<WmiMethodResult> results =
            _wmi.InvokeMethod(WmiScopes.CimV2, QueryFor(adapterId), method, parameters);

        if (results.Count == 0)
        {
            throw new InvalidOperationException(
                $"No network adapter with settings id '{adapterId}' is present on this machine.");
        }

        WmiMethodResult result = results[0];

        // 0 is success; 1 is "success, restart required", which for these
        // methods means the change is in force and Windows would like a reboot
        // to tidy up. Neither is a failure.
        if (result.ReturnValue is not (0 or 1))
        {
            throw new InvalidOperationException(
                $"{method} on adapter '{adapterId}' returned {result.ReturnValue}.");
        }
    }

    private static IReadOnlyList<string> OnlyIpv4(IReadOnlyList<string>? addresses) =>
        addresses is null
            ? Array.Empty<string>()
            : addresses
                .Where(a => System.Net.IPAddress.TryParse(a, out System.Net.IPAddress? parsed) &&
                            parsed.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                .ToArray();
}
