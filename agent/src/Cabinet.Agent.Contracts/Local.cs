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
}

public sealed record AgentConfig
{
    public required Guid CabinetId { get; init; }
    public required bool ReadOnlyMode { get; init; }
    public required CabinetRole? CabinetRole { get; init; }
    public required ScannerConfig Scanner { get; init; }
    public required SyncCabinetConfig SyncCabinet { get; init; }
    public required PlatformServerConfig PlatformServer { get; init; }
    public required IReadOnlyList<int> AllowedTcpPorts { get; init; }
    public required bool LocalHarness { get; init; }
}

public enum BrokerRequestKind { Ping, Operation }

public sealed record BrokerRequest
{
    public required Guid RequestId { get; init; }
    public required BrokerRequestKind Kind { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Operation { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public JsonElement? Params { get; init; }
}

public enum BrokerStatus { Succeeded, Failed }

public sealed record BrokerResponse
{
    public required Guid RequestId { get; init; }
    public required BrokerStatus Status { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public JsonElement? Output { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ResultError? Error { get; init; }
}
