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
