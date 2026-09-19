namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>A native read outcome. Unknown is never equivalent to enabled or safe.</summary>
public enum FirewallReadStatus
{
    /// <summary>No usable observation.</summary>
    Unknown = 0,
    /// <summary>The indicated read completed, not a connectivity diagnosis.</summary>
    Read = 1,
    /// <summary>Windows refused access.</summary>
    AccessDenied = 2,
    /// <summary>The Windows API was unavailable or failed.</summary>
    Unavailable = 3,
    /// <summary>The operating system does not support this inspection.</summary>
    Unsupported = 4,
    /// <summary>Only part of the requested fixed inspection completed.</summary>
    Partial = 5,
}

/// <summary>Bounded historical INetFwPolicy2 metadata, never authorization to write.</summary>
public sealed record FirewallInspection
{
    /// <summary>Wire shape version.</summary>
    public int Version { get; init; } = 1;
    /// <summary>When inspection began, in UTC.</summary>
    public DateTimeOffset ObservedUtc { get; init; }
    /// <summary>Overall native read state.</summary>
    public FirewallReadStatus Status { get; init; }
    /// <summary>Windows active-profile bitmask, or unknown.</summary>
    public int? ActiveProfiles { get; init; }
    /// <summary>NET_FW_MODIFY_STATE from Windows, or unknown. Not per-rule GPO provenance.</summary>
    public int? LocalPolicyModifyState { get; init; }
    /// <summary>The three fixed profile reads.</summary>
    public IReadOnlyList<FirewallProfileObservation> Profiles { get; init; } = Array.Empty<FirewallProfileObservation>();
    /// <summary>At most 128 rule metadata rows, not necessarily all rules.</summary>
    public IReadOnlyList<FirewallRuleObservation> Rules { get; init; } = Array.Empty<FirewallRuleObservation>();
    /// <summary>True if completeness cannot be established within the row/time bounds.</summary>
    public bool RulesTruncated { get; init; }
    /// <summary>True when a string was clipped or control characters removed.</summary>
    public bool TextTruncated { get; init; }
    /// <summary>Fixed diagnostic text; never native exception messages.</summary>
    public string Note { get; init; } = "No inspection available.";
    /// <summary>Limits of the source. This API does not establish effective packet permission.</summary>
    public string PolicyCaveat { get; init; } = "INetFwPolicy2 metadata is not a resultant-policy or packet-path verdict. Per-rule GPO source and local-rule merge policy are not established. Connectivity failure does not establish firewall causation. No settings were changed.";
}

/// <summary>Observed domain (1), private (2), or public (4) profile settings.</summary>
public sealed record FirewallProfileObservation
{
    /// <summary>NET_FW_PROFILE_TYPE2 value.</summary>
    public int Profile { get; init; }
    /// <summary>Whether this profile was readable.</summary>
    public FirewallReadStatus Status { get; init; }
    /// <summary>FirewallEnabled; null means unknown.</summary>
    public bool? Enabled { get; init; }
    /// <summary>BlockAllInboundTraffic; null means unknown.</summary>
    public bool? BlockAllInbound { get; init; }
    /// <summary>NET_FW_ACTION, block=0, allow=1; null means unknown.</summary>
    public int? DefaultInboundAction { get; init; }
    /// <summary>NET_FW_ACTION, block=0, allow=1; null means unknown.</summary>
    public int? DefaultOutboundAction { get; init; }
}

/// <summary>Read-only rule metadata. Display names are not unique rule identities.</summary>
public sealed record FirewallRuleObservation
{
    /// <summary>Bounded display name, not a mutation selector.</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>Configured enabled value, not proof the rule is effective.</summary>
    public bool Enabled { get; init; }
    /// <summary>Windows profile bitmask.</summary>
    public int Profiles { get; init; }
    /// <summary>NET_FW_RULE_DIRECTION, inbound=1, outbound=2.</summary>
    public int Direction { get; init; }
    /// <summary>NET_FW_ACTION, block=0, allow=1.</summary>
    public int Action { get; init; }
    /// <summary>IP protocol number; 256 means any.</summary>
    public int Protocol { get; init; }
    /// <summary>Bounded configured local ports, only for TCP/UDP.</summary>
    public string LocalPorts { get; init; } = string.Empty;
    /// <summary>Bounded configured remote ports, only for TCP/UDP.</summary>
    public string RemotePorts { get; init; } = string.Empty;
    /// <summary>Bounded configured local addresses.</summary>
    public string LocalAddresses { get; init; } = string.Empty;
    /// <summary>Bounded configured remote addresses.</summary>
    public string RemoteAddresses { get; init; } = string.Empty;
}
