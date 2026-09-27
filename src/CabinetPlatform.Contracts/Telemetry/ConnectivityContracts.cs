using System.Net;
using System.Net.Sockets;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Administrator-pinned office lab endpoints, never DNS or discovery targets.</summary>
public sealed record ConnectivityTarget
{
    /// <summary>Registered target identity.</summary>
    public Guid CabinetId { get; init; }
    /// <summary>Canonical administrator-approved private IPv4 literal.</summary>
    public string Address { get; init; } = string.Empty;
    /// <summary>Whether this is the site’s designated sync cabinet.</summary>
    public bool IsSync { get; init; }
}

/// <summary>Replaces the bounded target set; an empty set disables monitoring.</summary>
public sealed record ConfigureConnectivityRequest
{
    /// <summary>Required operator justification.</summary>
    public string Reason { get; init; } = string.Empty;
    /// <summary>Approved target set; never a subnet or a range.</summary>
    public IReadOnlyList<ConnectivityTarget> Targets { get; init; } = Array.Empty<ConnectivityTarget>();
}

/// <summary>Short-lived server authorization for fixed observational probes.</summary>
public sealed record ConnectivityPlan
{
    /// <summary>Wire protocol version.</summary>
    public int Version { get; init; } = 1;
    /// <summary>Configuration revision, changed on every administrative edit.</summary>
    public Guid ConfigurationId { get; init; }
    /// <summary>Approved source identity.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Site boundary for this configuration.</summary>
    public Guid SiteId { get; init; }
    /// <summary>Server issuance timestamp.</summary>
    public DateTimeOffset IssuedUtc { get; init; }
    /// <summary>Hard deadline after which the agent must stop probing.</summary>
    public DateTimeOffset ExpiresUtc { get; init; }
    /// <summary>Fixed sampling cadence in seconds.</summary>
    public int IntervalSeconds { get; init; } = 60;
    /// <summary>Approved target set; never a subnet or a range.</summary>
    public IReadOnlyList<ConnectivityTarget> Targets { get; init; } = Array.Empty<ConnectivityTarget>();
}

/// <summary>Independent compiled bounds, applied at both ends of the protocol.</summary>
public static class ConnectivityLimits
{
    /// <summary>Hard cap on simultaneously monitored targets.</summary>
    public const int MaximumTargets = 4;
    /// <summary>One probe per minute per target.</summary>
    public const int IntervalSeconds = 60;
    /// <summary>Samples aggregated before any upload.</summary>
    public const int SamplesPerSummary = 3;

    // The office slice intentionally supports only literal RFC1918 IPv4 unicast.
    // Reject noncanonical forms and common /24 network/broadcast addresses too.
    /// <summary>Refuses public, loopback, link-local, multicast, DNS and ambiguous literals.</summary>
    public static bool IsAllowedAddress(string? value) =>
        IPAddress.TryParse(value, out var ip) && ip.AddressFamily == AddressFamily.InterNetwork &&
        ip.ToString() == value && IsPrivateHost(ip.GetAddressBytes());

    private static bool IsPrivateHost(byte[] b) => b[3] is > 0 and < 255 &&
        (b[0] == 10 || b[0] == 172 && b[1] is >= 16 and <= 31 || b[0] == 192 && b[1] == 168);
}
