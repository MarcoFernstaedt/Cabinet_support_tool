using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// Network adapters, firewall profile state, proxy configuration and
/// reachability of the platform server from the cabinet PC.
/// </summary>
/// <remarks>
/// Reachability is measured outbound, from the cabinet to the server. Nothing
/// in this platform listens for inbound connections into a cabinet.
/// </remarks>
public sealed record NetworkInfo
{
    /// <summary>Network adapters present on the machine.</summary>
    public IReadOnlyList<NetworkAdapterInfo>? Adapters { get; init; }

    /// <summary>Whether a proxy is configured for outbound traffic.</summary>
    public bool? ProxyConfigured { get; init; }

    /// <summary>Configured proxy address, or <see langword="null"/> when none is configured.</summary>
    public string? ProxyAddress { get; init; }

    /// <summary>Whether the Windows Firewall domain profile is enabled.</summary>
    public bool? FirewallDomainEnabled { get; init; }

    /// <summary>Whether the Windows Firewall private profile is enabled.</summary>
    public bool? FirewallPrivateEnabled { get; init; }

    /// <summary>Whether the Windows Firewall public profile is enabled.</summary>
    public bool? FirewallPublicEnabled { get; init; }

    /// <summary>Whether the agent could reach the platform server on its last attempt.</summary>
    public bool? ServerReachable { get; init; }

    /// <summary>Round-trip latency to the platform server, in milliseconds.</summary>
    public double? ServerLatencyMs { get; init; }
}

/// <summary>
/// A single network adapter and its addressing.
/// </summary>
public sealed record NetworkAdapterInfo
{
    /// <summary>Connection name as shown in Windows.</summary>
    public required string Name { get; init; }

    /// <summary>Adapter hardware description.</summary>
    public string? Description { get; init; }

    /// <summary>MAC address of the adapter.</summary>
    public string? MacAddress { get; init; }

    /// <summary>Operational status of the adapter.</summary>
    public required NetworkAdapterStatus Status { get; init; }

    /// <summary>Negotiated link speed, in bits per second.</summary>
    public long? LinkSpeedBps { get; init; }

    /// <summary>IP addresses bound to the adapter.</summary>
    public IReadOnlyList<string>? IpAddresses { get; init; }

    /// <summary>Subnet masks or prefixes corresponding to the bound addresses.</summary>
    public IReadOnlyList<string>? SubnetMasks { get; init; }

    /// <summary>Default gateways configured on the adapter.</summary>
    public IReadOnlyList<string>? Gateways { get; init; }

    /// <summary>DNS servers configured on the adapter.</summary>
    public IReadOnlyList<string>? DnsServers { get; init; }

    /// <summary>Whether the adapter obtains its address by DHCP.</summary>
    public bool? DhcpEnabled { get; init; }
}

/// <summary>
/// Operational status of a network adapter.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum NetworkAdapterStatus
{
    /// <summary>The status could not be determined.</summary>
    Unknown = 0,

    /// <summary>The adapter is up and passing traffic.</summary>
    Up = 1,

    /// <summary>The adapter is down.</summary>
    Down = 2,

    /// <summary>The adapter is in a test mode.</summary>
    Testing = 3,

    /// <summary>The adapter is dormant, waiting for an external event.</summary>
    Dormant = 4,

    /// <summary>The adapter hardware is not present.</summary>
    NotPresent = 5,

    /// <summary>A lower layer the adapter depends on is down.</summary>
    LowerLayerDown = 6,
}
