using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// A Windows service as observed on the cabinet PC.
/// </summary>
/// <remarks>
/// There is deliberately no "should be running but is stopped" field here.
/// That judgement is derived server-side from <see cref="StartType"/> and
/// <see cref="State"/>, so the rule lives in one place and the agent reports
/// only what it saw.
/// </remarks>
public sealed record ServiceInfo
{
    /// <summary>Service short name, as used by the service control manager.</summary>
    public required string Name { get; init; }

    /// <summary>Friendly display name shown in Windows.</summary>
    public string? DisplayName { get; init; }

    /// <summary>Current run state.</summary>
    public required ServiceState State { get; init; }

    /// <summary>Configured start type.</summary>
    public required ServiceStartType StartType { get; init; }

    /// <summary>Account the service runs as, for example "LocalSystem".</summary>
    public string? RunAsAccount { get; init; }

    /// <summary>Process identifier hosting the service, or <see langword="null"/> when it is not running.</summary>
    public int? ProcessId { get; init; }
}

/// <summary>
/// Run state of a Windows service.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ServiceState
{
    /// <summary>The state could not be read. Never treat this as stopped or running.</summary>
    Unknown = 0,

    /// <summary>The service is not running.</summary>
    Stopped = 1,

    /// <summary>The service is starting.</summary>
    StartPending = 2,

    /// <summary>The service is stopping.</summary>
    StopPending = 3,

    /// <summary>The service is running.</summary>
    Running = 4,

    /// <summary>The service is resuming from paused.</summary>
    ContinuePending = 5,

    /// <summary>The service is pausing.</summary>
    PausePending = 6,

    /// <summary>The service is paused.</summary>
    Paused = 7,
}

/// <summary>
/// Configured start type of a Windows service.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ServiceStartType
{
    /// <summary>The start type could not be read.</summary>
    Unknown = 0,

    /// <summary>Started by the system loader (device drivers).</summary>
    Boot = 1,

    /// <summary>Started during kernel initialisation.</summary>
    System = 2,

    /// <summary>Started automatically at boot.</summary>
    Automatic = 3,

    /// <summary>Started automatically a short time after boot.</summary>
    AutomaticDelayed = 4,

    /// <summary>Started on demand.</summary>
    Manual = 5,

    /// <summary>Cannot be started.</summary>
    Disabled = 6,
}
