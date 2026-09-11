using System.ComponentModel.DataAnnotations;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Contracts.Agent;

/// <summary>An agent asking to join the fleet. Nothing it sends is trusted.</summary>
public sealed class AgentRegistrationRequest
{
    [Required, StringLength(128, MinimumLength = 1)]
    public string MachineId { get; set; } = string.Empty;

    [Required, StringLength(255, MinimumLength = 1)]
    public string Hostname { get; set; } = string.Empty;

    [StringLength(255)]
    public string? OsVersion { get; set; }

    [StringLength(64)]
    public string? AgentVersion { get; set; }
}

public sealed class AgentRegistrationResponse
{
    public RegistrationStatus Status { get; set; }

    /// <summary>Human-readable status for the agent's own log. Never carries fleet detail.</summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>How long the agent should wait before asking again.</summary>
    public int RetryAfterSeconds { get; set; }
}

/// <summary>One disk volume as observed by the agent.</summary>
public sealed class VolumeSnapshot
{
    public string VolumeId { get; set; } = string.Empty;
    public string? Label { get; set; }
    public string? FileSystem { get; set; }
    public long TotalBytes { get; set; }
    public long FreeBytes { get; set; }

    public double FreePercent => TotalBytes <= 0 ? 0d : FreeBytes * 100d / TotalBytes;
}

/// <summary>A pending Windows update the agent has seen but not installed.</summary>
public sealed class PendingUpdateSnapshot
{
    public string UpdateId { get; set; } = string.Empty;
    public string? Title { get; set; }
    public bool IsSecurityUpdate { get; set; }
    public bool RequiresReboot { get; set; }
}

/// <summary>State of one Windows service the agent was asked to watch.</summary>
public sealed class ServiceSnapshot
{
    public string ServiceName { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public string? Status { get; set; }
    public string? StartMode { get; set; }
}

/// <summary>
/// A full observation from one cabinet at one moment. The server stores the
/// serialised payload verbatim for forensics and additionally projects the
/// handful of fields it actually queries on into columns.
/// </summary>
public sealed class CheckInRequest
{
    [Required, StringLength(128, MinimumLength = 1)]
    public string MachineId { get; set; } = string.Empty;

    /// <summary>
    /// When the agent gathered this sample. Doubles as the idempotency key:
    /// re-sending the same (cabinet, CollectedAtUtc) pair must not create a
    /// second row, because agents retry over flaky clinic networks.
    /// </summary>
    [Required]
    public DateTime CollectedAtUtc { get; set; }

    [StringLength(255)]
    public string? Hostname { get; set; }

    [StringLength(64)]
    public string? AgentVersion { get; set; }

    [StringLength(255)]
    public string? OsVersion { get; set; }

    public double CpuPercent { get; set; }
    public double RamUsedPercent { get; set; }
    public long RamTotalBytes { get; set; }
    public TimeSpan? Uptime { get; set; }

    /// <summary>
    /// True if any interactive session is logged on. Disruptive actions are
    /// blocked on this: a reboot during a controlled-substance dispense is not
    /// an inconvenience, it is a chain-of-custody problem.
    /// </summary>
    public bool AnyUserLoggedOn { get; set; }

    public List<VolumeSnapshot> Volumes { get; set; } = new();
    public List<SmartSnapshot> SmartReadings { get; set; } = new();
    public List<PendingUpdateSnapshot> PendingUpdates { get; set; } = new();
    public List<ServiceSnapshot> Services { get; set; } = new();
}

public sealed class CheckInResponse
{
    public bool Accepted { get; set; }
    public DateTime ReceivedUtc { get; set; }

    /// <summary>True when this exact sample had already been stored.</summary>
    public bool WasDuplicate { get; set; }

    public int NextCheckInSeconds { get; set; }

    /// <summary>Set when at least one approved action is waiting to be collected.</summary>
    public bool HasPendingActions { get; set; }
}

/// <summary>
/// One approved action handed to the agent. Parameters have already been
/// validated against the catalogue's allow-list — the agent receives only keys
/// the server itself recognises.
/// </summary>
public sealed class AgentActionDispatch
{
    public Guid ActionRequestId { get; set; }
    public CabinetActionType Action { get; set; }
    public IDictionary<string, string> Parameters { get; set; } = new Dictionary<string, string>();
    public int TimeoutSeconds { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public DateTime DispatchedUtc { get; set; }
}

public sealed class AgentActionResultRequest
{
    [Required]
    public ActionResultStatus Status { get; set; }

    /// <summary>
    /// Agent-produced text describing the outcome. Truncated by the server; it
    /// is evidence, not a channel for the agent to steer the server.
    /// </summary>
    [StringLength(8000)]
    public string? Output { get; set; }

    public DateTime? StartedUtc { get; set; }
    public DateTime? CompletedUtc { get; set; }
    public int? ExitCode { get; set; }
}
