using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Shared shapes from contracts/schemas/common.schema.json.
// Convention: a property the schema does not require is nullable and carries
// [JsonIgnore(Condition = WhenWritingNull)], so it is omitted when null. A
// required property is always written, including when its value is null.

public enum EventLevel { Critical, Error, Warning, Information, Verbose }
public enum CabinetRole { Sync, Satellite, Standalone }
public enum FirewallProfile { Domain, Private, Public }
public enum FirewallAction { Allow, Block }
public enum FirewallDirection { In, Out }
public enum FirewallProtocol { Any, Tcp, Udp, Icmpv4 }

/// <summary>Operations that take no parameters accept only {}.</summary>
public sealed record EmptyParams;

public sealed record PortRange
{
    public required int From { get; init; }
    public required int To { get; init; }
}

public sealed record FirewallRule
{
    public required string Name { get; init; }
    public required FirewallDirection Direction { get; init; }
    public required FirewallAction Action { get; init; }
    public required FirewallProtocol Protocol { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<PortRange>? LocalPorts { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<PortRange>? RemotePorts { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<string>? LocalAddresses { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<string>? RemoteAddresses { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ProgramPath { get; init; }
    public required IReadOnlyList<FirewallProfile> Profiles { get; init; }
    public required bool Enabled { get; init; }
}

public sealed record ReportedFirewallRule
{
    public required string Name { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? DisplayGroup { get; init; }
    public required FirewallDirection Direction { get; init; }
    public required FirewallAction Action { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Protocol { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? LocalPorts { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? RemotePorts { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? LocalAddresses { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? RemoteAddresses { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ProgramPath { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<FirewallProfile>? Profiles { get; init; }
    public required bool Enabled { get; init; }
    public required bool CreatedByPlatform { get; init; }
}

public sealed record FirewallProfileState
{
    public required FirewallProfile Profile { get; init; }
    public required bool Enabled { get; init; }
    public required FirewallAction DefaultInbound { get; init; }
    public required FirewallAction DefaultOutbound { get; init; }
    public required DateTimeOffset? ReenableAt { get; init; }
}

public sealed record Ipv4Address
{
    public required string Address { get; init; }
    public required int PrefixLength { get; init; }
}

public sealed record Ipv4Settings
{
    public required bool Dhcp { get; init; }
    public required IReadOnlyList<Ipv4Address> Addresses { get; init; }
    public required IReadOnlyList<string> Gateways { get; init; }
}

public sealed record DnsSettings
{
    public required bool Automatic { get; init; }
    public required IReadOnlyList<string> Servers { get; init; }
}
