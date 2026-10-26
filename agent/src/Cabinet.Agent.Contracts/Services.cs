using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Services and processes (docs/spec/12-milestones-8-to-12.md, milestone 10): services.list, processes.list,
// service.control, and the watched-services list the broker keeps running.

public enum ServiceState { Running, Stopped, StartPending, StopPending, Paused, PausePending, ContinuePending, Unknown }

public enum ServiceStartType { Automatic, AutomaticDelayed, Manual, Disabled, Boot, System, Unknown }

public enum RecoveryAction { None, Restart, Reboot, RunProgram }

public enum WatchState { Running, Restarted, Failing, Missing, Disabled, Refused, Waiting }

public enum ServiceAction { Start, Stop, Restart }

public sealed record ServiceRecovery
{
    public required RecoveryAction FirstFailure { get; init; }
    public required RecoveryAction SecondFailure { get; init; }
    public required RecoveryAction SubsequentFailures { get; init; }
    public required long ResetPeriodSeconds { get; init; }
}

public sealed record ServiceInfo
{
    public required string Name { get; init; }
    public required string DisplayName { get; init; }
    public required ServiceState State { get; init; }
    public required ServiceStartType StartType { get; init; }
    public required string? Account { get; init; }
    public required long? ProcessId { get; init; }
    /// <summary>The program only, never its arguments.</summary>
    public required string? ExecutablePath { get; init; }
    public required string? Description { get; init; }
    public required ServiceRecovery? Recovery { get; init; }
}

public sealed record WatchedServiceStatus
{
    public required string Name { get; init; }
    public required WatchState State { get; init; }
    public required ServiceState? ServiceState { get; init; }
    public required long RestartsToday { get; init; }
    public required long ConsecutiveFailures { get; init; }
    public required DateTimeOffset? LastRestartAt { get; init; }
    public required long? LastError { get; init; }
    public required DateTimeOffset? CheckedAt { get; init; }
}

public sealed record ServicesListOutput
{
    public required IReadOnlyList<ServiceInfo> Services { get; init; }
    public required IReadOnlyList<WatchedServiceStatus> Watched { get; init; }
}

public sealed record ProcessInfo
{
    public required long ProcessId { get; init; }
    public required string Name { get; init; }
    public required string? ExecutablePath { get; init; }
    public required double CpuPercent { get; init; }
    public required long WorkingSetBytes { get; init; }
    public required long PrivateBytes { get; init; }
    public required long Threads { get; init; }
    public required long Handles { get; init; }
    public required DateTimeOffset? StartTime { get; init; }
    public required long SessionId { get; init; }
    public required string? Account { get; init; }
}

public sealed record ProcessesListOutput
{
    public required IReadOnlyList<ProcessInfo> Processes { get; init; }
    public required long SampleMilliseconds { get; init; }
    public required bool Truncated { get; init; }
}

public sealed record ServiceControlParams
{
    public required string Name { get; init; }
    public required ServiceAction Action { get; init; }
}

public sealed record ServiceSetStartTypeParams
{
    public required string Name { get; init; }
    /// <summary>Automatic, AutomaticDelayed, Manual or Disabled; boot and system are refused by the contract.</summary>
    public required ServiceStartType StartType { get; init; }
}

public sealed record ServiceSetStartTypeOutput
{
    public required string Name { get; init; }
    public required ServiceStartType Before { get; init; }
    public required ServiceStartType After { get; init; }
}

public sealed record ServiceControlOutput
{
    public required string Name { get; init; }
    public required ServiceAction Action { get; init; }
    public required ServiceState Before { get; init; }
    public required ServiceState After { get; init; }
}

/// <summary>The broker's answer to watchStatus.</summary>
public sealed record ServiceWatch
{
    public required IReadOnlyList<WatchedServiceStatus> Watched { get; init; }
}

/// <summary>The heartbeat response's watched-services setting.</summary>
public sealed record HeartbeatWatchedServices
{
    public required IReadOnlyList<string> Names { get; init; }
}

/// <summary>
/// The heartbeat response's approved-applications list (milestone 10): the programs this cabinet may be asked to start,
/// stop or restart, resolved by the server for it. The agent keeps its own copy and acts only on these.
/// </summary>
public sealed record HeartbeatApprovedApps
{
    public required IReadOnlyList<ApprovedAppEntry> Entries { get; init; }
    /// <summary>The same list as an Admin signed it; absent until it is signed, and from a server or agent before signing.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public SignedApprovedList? Signed { get; init; }
}

/// <summary>A signed approved list as the heartbeat answer carries it: base64 of the document's exact bytes and the signature over them.</summary>
public sealed record SignedApprovedList
{
    public required string Document { get; init; }
    public required ApprovedListSignature Signature { get; init; }
}

public enum ApprovedAppKind { Application, Service }

public enum ApprovedListLevel { Fleet, Client, Site, Cabinet }

/// <summary>
/// One level's approved programs as an Admin signs them (agent/approved-list.schema.json). The broker reads this only after
/// the signature over its exact bytes has verified against a list-signing key compiled into the agent.
/// </summary>
public sealed record ApprovedListDocument
{
    public required string Product { get; init; }
    public required ApprovedListLevel Level { get; init; }
    public required Guid? ScopeId { get; init; }
    public required int Version { get; init; }
    public required DateTimeOffset IssuedAt { get; init; }
    public required IReadOnlyList<ApprovedAppEntry> Entries { get; init; }
}

/// <summary>The detached signature over an approved-list document's exact bytes (agent/approved-list-signature.schema.json).</summary>
public sealed record ApprovedListSignature
{
    public required string KeyId { get; init; }
    public required string Algorithm { get; init; }
    public required string Signature { get; init; }
}

public sealed record ApprovedListKey
{
    public required string KeyId { get; init; }
    public required string Name { get; init; }
    public required string PublicKey { get; init; }
}

/// <summary>The Admin list-signing keys (agent/approved-list-keys.schema.json). Compiled in; only a signed agent upgrade changes them.</summary>
public sealed record ApprovedListKeys
{
    public required int Version { get; init; }
    public required IReadOnlyList<ApprovedListKey> Keys { get; init; }
}

/// <summary>
/// One program a cabinet may be asked to start, stop or restart: an application, or a service with its key name. The path
/// is the whole executable path, never a command line, and it is what the cabinet checks the running program against,
/// exactly, before it acts on it.
/// </summary>
public sealed record ApprovedAppEntry
{
    /// <summary>How a request names this entry: app: followed by the entry's short name.</summary>
    public required string Key { get; init; }
    public required ApprovedAppKind Kind { get; init; }
    /// <summary>What the operator called it (a display name, never the thing that is matched on).</summary>
    public required string Name { get; init; }
    public required string Path { get; init; }
    /// <summary>The service's key name; present for a service entry, absent for an application (the contract's rule).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ServiceName { get; init; }
}
