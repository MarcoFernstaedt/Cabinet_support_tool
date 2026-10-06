using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Write operations (Tier 2 and Admin, step-up required; docs/spec/04-agent-spec.md).
// One operation on one cabinet. No bulk forms exist.

public enum IpMode { Dhcp, Static }

public sealed record NetworkSetIpParams
{
    public required int InterfaceIndex { get; init; }
    public required IpMode Mode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Address { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? PrefixLength { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Gateway { get; init; }
}

public sealed record NetworkSetIpOutput
{
    public required int InterfaceIndex { get; init; }
    public required Ipv4Settings Before { get; init; }
    public required Ipv4Settings After { get; init; }
    public required DateTimeOffset SafetyNetDeadline { get; init; }
}

public enum DnsMode { Automatic, Static }

public sealed record NetworkSetDnsParams
{
    public required int InterfaceIndex { get; init; }
    public required DnsMode Mode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<string>? Servers { get; init; }
}

public sealed record NetworkSetDnsOutput
{
    public required int InterfaceIndex { get; init; }
    public required DnsSettings Before { get; init; }
    public required DnsSettings After { get; init; }
    public required DateTimeOffset SafetyNetDeadline { get; init; }
}

public sealed record FirewallSetProfileParams
{
    public required FirewallProfile Profile { get; init; }
    public required bool Enabled { get; init; }
    public required FirewallAction DefaultInbound { get; init; }
    public required FirewallAction DefaultOutbound { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? DurationMinutes { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? NoTimeLimit { get; init; }
}

public sealed record FirewallSetProfileOutput
{
    public required FirewallProfile Profile { get; init; }
    public required FirewallProfileState Before { get; init; }
    public required FirewallProfileState After { get; init; }
    public required Guid SnapshotId { get; init; }
    public required DateTimeOffset SafetyNetDeadline { get; init; }
}

public enum RuleChange { Create, Update, Enable, Disable, Delete }

public sealed record FirewallSetRuleParams
{
    public required RuleChange Change { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? RuleName { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public FirewallRule? Rule { get; init; }
}

public sealed record FirewallSetRuleOutput
{
    public required RuleChange Change { get; init; }
    public required ReportedFirewallRule? Before { get; init; }
    public required ReportedFirewallRule? After { get; init; }
    public required Guid SnapshotId { get; init; }
    public required DateTimeOffset SafetyNetDeadline { get; init; }
}

public sealed record FirewallRestoreParams
{
    public required Guid SnapshotId { get; init; }
}

public sealed record FirewallRestoreOutput
{
    public required Guid RestoredSnapshotId { get; init; }
    public required Guid PreRestoreSnapshotId { get; init; }
    public required DateTimeOffset RestoredAt { get; init; }
    public required DateTimeOffset SafetyNetDeadline { get; init; }
}

/// <summary>Only these two package types exist. EXE installers and scripts are not supported, on purpose.</summary>
public enum PackageType { Driver, Msi }

public enum CheckOutcome { Passed, Failed, NotRun }

public sealed record PackageInstallParams
{
    public required Guid PackageId { get; init; }
    public required PackageType PackageType { get; init; }
    public required string Sha256 { get; init; }
}

public sealed record PackageChecks
{
    public required CheckOutcome Hash { get; init; }
    public required CheckOutcome Signature { get; init; }
    public required CheckOutcome Publisher { get; init; }
}

public sealed record PackageInstallOutput
{
    public required Guid PackageId { get; init; }
    public required PackageType PackageType { get; init; }
    public required PackageChecks Checks { get; init; }
    public required string? Signer { get; init; }
    public required bool Installed { get; init; }
    public required long? ExitCode { get; init; }
    public required bool RebootRequired { get; init; }
}

public sealed record DriverUninstallParams
{
    public required string PublishedName { get; init; }
}

public sealed record DriverUninstallOutput
{
    public required string PublishedName { get; init; }
    public required bool Removed { get; init; }
    public required bool RebootRequired { get; init; }
}
