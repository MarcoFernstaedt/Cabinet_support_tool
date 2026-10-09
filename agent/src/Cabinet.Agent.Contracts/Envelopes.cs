using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Envelopes from contracts/schemas/envelopes (docs/spec/03-protocol.md).

public sealed record Command
{
    public required Guid CommandId { get; init; }
    public required Guid CabinetId { get; init; }
    /// <summary>Must be a name in <see cref="Catalog"/>; anything else is rejected as unknown_operation.</summary>
    public required string Operation { get; init; }
    /// <summary>Raw parameters, validated against the operation's schema before being read.</summary>
    public required JsonElement Params { get; init; }
    public required Guid IssuedBy { get; init; }
    public required DateTimeOffset IssuedAt { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
}

public enum ResultStatus { Succeeded, Failed, Rejected }

public sealed record ResultError
{
    /// <summary>One of <see cref="Catalog.RejectionCodes"/> or <see cref="Catalog.FailureCodes"/>.</summary>
    public required string Code { get; init; }
    public required string Message { get; init; }
    /// <summary>Only in a broker's answer to an upgrade: which check refused the release.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public UpgradeCheck? Check { get; init; }
}

public sealed record Result
{
    public required Guid CommandId { get; init; }
    public required ResultStatus Status { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public required DateTimeOffset FinishedAt { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public JsonElement? Output { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ResultError? Error { get; init; }
}

public enum EventKind { Error, FirewallChanged, SmartWarning, AgentStatus, Security, Scanner, Service }

public enum ScannerState { Disconnected, DeviceError, DriverMissing, Recovered }

public sealed record ScannerDevice
{
    public required IReadOnlyList<string> HardwareIds { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? DeviceInstanceId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Name { get; init; }
    public required ScannerState State { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? ProblemCode { get; init; }
}
public enum SeverityHint { Major, Minor }

public sealed record EventSource
{
    public required string Log { get; init; }
    public required string Source { get; init; }
    public required int EventId { get; init; }
    public required EventLevel Level { get; init; }
    public required long RecordId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? HardwareId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? DeviceInstanceId { get; init; }
}

public sealed record EventDetail
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Message { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyDictionary<string, string>? Fields { get; init; }
}

public sealed record AgentEvent
{
    public required Guid EventId { get; init; }
    public required EventKind Kind { get; init; }
    public required DateTimeOffset OccurredAt { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public EventSource? Source { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public Guid? CommandId { get; init; }
    public required SeverityHint SeverityHint { get; init; }
    public required EventDetail Detail { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ScannerDevice? Device { get; init; }
}

public sealed record EventBatch
{
    public required IReadOnlyList<AgentEvent> Events { get; init; }
}

public sealed record Heartbeat
{
    public required string AgentVersion { get; init; }
    public required long UptimeSeconds { get; init; }
    public required bool ReadOnlyMode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? ClockSkewSeconds { get; init; }
    /// <summary>Each firewall profile on or off as last seen; compared by the server with the client's firewall policy.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public FirewallProfileSwitches? FirewallProfiles { get; init; }
}

public sealed record ServerAck
{
    public required DateTimeOffset ServerTime { get; init; }
}

public sealed record HeartbeatScanner
{
    public required IReadOnlyList<string>? HardwareIds { get; init; }
}

/// <summary>The server's answer to a heartbeat: its time and the settings the background monitors use. Data only.</summary>
public sealed record HeartbeatResponse
{
    public required DateTimeOffset ServerTime { get; init; }
    public required HeartbeatScanner Scanner { get; init; }
    /// <summary>An agent release this cabinet is offered by a running rollout.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public UpgradeOffer? Upgrade { get; init; }
    /// <summary>The services this cabinet keeps running (milestone 10); absent from servers before it.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public HeartbeatWatchedServices? WatchedServices { get; init; }
}

public sealed record CommandsResponse
{
    public required DateTimeOffset ServerTime { get; init; }
    public required IReadOnlyList<Command> Commands { get; init; }
}

public sealed record EnrollFingerprints
{
    public required string Hostname { get; init; }
    public required string? SerialNumber { get; init; }
    public required IReadOnlyList<string> MacAddresses { get; init; }
    public required string? ProvisionedClient { get; init; }
    public required string? ProvisionedSite { get; init; }
    public required DateTimeOffset OnlineSince { get; init; }
    public required string OsVersion { get; init; }
    public required string AgentVersion { get; init; }
}

public sealed record EnrollRequest
{
    public required string Csr { get; init; }
    public required string BootstrapToken { get; init; }
    public required EnrollFingerprints Fingerprints { get; init; }
}

public sealed record EnrollResponse
{
    public required Guid RequestId { get; init; }
    /// <summary>Always "pending".</summary>
    public required string Status { get; init; }
    public required DateTimeOffset ServerTime { get; init; }
}

public enum EnrollState { Pending, Rejected, Issued }

public sealed record EnrollStatus
{
    public required Guid RequestId { get; init; }
    public required EnrollState Status { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Certificate { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? CaChain { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public Guid? CabinetId { get; init; }
    public required DateTimeOffset ServerTime { get; init; }
}

public sealed record RenewRequest
{
    public required string Csr { get; init; }
}

public sealed record RenewResponse
{
    public required string Certificate { get; init; }
    public required string CaChain { get; init; }
    public required DateTimeOffset ServerTime { get; init; }
}
