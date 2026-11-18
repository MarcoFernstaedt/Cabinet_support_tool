using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Contracts that never leave the cabinet: the local configuration and the
// broker pipe messages (contracts/schemas/agent/).

public sealed record ScannerConfig
{
    public required IReadOnlyList<string> HardwareIds { get; init; }
}

public sealed record SyncCabinetConfig
{
    public required string? Address { get; init; }
}

public sealed record PlatformServerConfig
{
    public required string? Host { get; init; }
    public required int? Port { get; init; }
}

public sealed record AgentConfig
{
    /// <summary>Local harness only, before enrollment. An enrolled agent uses the cabinet ID from its certificate.</summary>
    public required Guid? CabinetId { get; init; }
    public bool SessionsEnabled { get; init; }
    /// <summary>Accepted for compatibility with existing config files. The agent ignores it.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? DevelopmentShellEnabled { get; init; }
    /// <summary>Only true allows a development build to connect to the existing SSH server on 127.0.0.1:22.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? DevelopmentSshTransportEnabled { get; init; }
    public required bool ReadOnlyMode { get; init; }
    public required CabinetRole? CabinetRole { get; init; }
    public required ScannerConfig Scanner { get; init; }
    public required SyncCabinetConfig SyncCabinet { get; init; }
    public required PlatformServerConfig PlatformServer { get; init; }
    public required IReadOnlyList<int> AllowedTcpPorts { get; init; }
    public required bool LocalHarness { get; init; }
}

public enum BrokerRequestKind { Ping, Operation, Confirm, Upgrade, Watch, WatchStatus }

public sealed record BrokerRequest
{
    public required Guid RequestId { get; init; }
    public required BrokerRequestKind Kind { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Operation { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public JsonElement? Params { get; init; }
    /// <summary>The platform command a write (or a confirm) belongs to.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public Guid? CommandId { get; init; }
    /// <summary>For an upgrade: the downloaded release's version. Never a path.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Version { get; init; }
    /// <summary>For watch: the complete list of services to keep running. Names only.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<string>? Services { get; init; }
}

public enum BrokerStatus { Succeeded, Failed }

public sealed record BrokerResponse
{
    public required Guid RequestId { get; init; }
    public required BrokerStatus Status { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public JsonElement? Output { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ResultError? Error { get; init; }
}

public enum SafetyNetState { Kept, RolledBack, Unknown }

/// <summary>The broker's answer to a confirm: whether a command's change is kept or was already rolled back.</summary>
public sealed record SafetyNetStatus
{
    public required Guid CommandId { get; init; }
    public required SafetyNetState State { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public DateTimeOffset? RolledBackAt { get; init; }
}

public sealed record TrustedRoot
{
    public required string Name { get; init; }
    public required string Sha256 { get; init; }
    public required string File { get; init; }
}

public sealed record TrustedPublisher
{
    public required string Name { get; init; }
    public required string CommonName { get; init; }
    public required string Organization { get; init; }
    public required string Root { get; init; }
    public required IReadOnlyList<PackageType> PackageTypes { get; init; }
    public required string Reason { get; init; }
}

/// <summary>The signers the agent accepts for packages. Compiled in; only a signed agent upgrade changes it.</summary>
public sealed record TrustedPublishers
{
    public required int Version { get; init; }
    public required IReadOnlyList<TrustedRoot> Roots { get; init; }
    public required IReadOnlyList<TrustedPublisher> Publishers { get; init; }
}
