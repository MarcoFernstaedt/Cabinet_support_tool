namespace Mashura.CabinetSupport.Contracts.Enums;

/// <summary>
/// Support roles, ordered by privilege. The numeric ordering is meaningful:
/// a minimum-role check is a <c>&gt;=</c> comparison, so never renumber these.
/// </summary>
public enum UserRole
{
    Tier1 = 1,
    Tier2 = 2,
    Supervisor = 3
}

/// <summary>
/// Structural distinction between audit records that describe something the
/// server saw and records that describe something the server made happen on a
/// cabinet. These are never interchangeable and must never be merged.
/// </summary>
public enum AuditEventKind
{
    /// <summary>A read, a query, a check-in — no cabinet state changed.</summary>
    Observed = 1,

    /// <summary>State on a cabinet changed, or was requested/approved to change.</summary>
    Caused = 2
}

/// <summary>Outcome recorded against an audit entry.</summary>
public enum AuditResult
{
    Success = 1,
    Denied = 2,
    Failure = 3
}

/// <summary>
/// The complete catalogue of things this system can ask a cabinet to do.
/// This is a closed enum on purpose: there is no free-form command, script or
/// SQL path anywhere in the product, at any role.
/// </summary>
public enum CabinetActionType
{
    ScanForUpdates = 1,
    CollectDiagnosticBundle = 2,
    FlushDnsCache = 3,
    RenewDhcpLease = 4,
    RestartService = 5,
    StartService = 6,
    StopService = 7,
    ScheduleUpdates = 8,
    RebootMachine = 9
}

/// <summary>Lifecycle of a requested action.</summary>
public enum ActionRequestStatus
{
    PendingApproval = 1,
    Approved = 2,
    Denied = 3,
    Dispatched = 4,
    Completed = 5,
    Expired = 6,
    Cancelled = 7
}

/// <summary>Outcome an agent reports for a dispatched action.</summary>
public enum ActionResultStatus
{
    Succeeded = 1,
    Failed = 2,
    TimedOut = 3,
    Refused = 4
}

/// <summary>Lifecycle of an agent's request to join the fleet.</summary>
public enum RegistrationStatus
{
    Pending = 1,
    Approved = 2,
    Rejected = 3
}

/// <summary>Health of a single physical drive as derived from SMART data.</summary>
public enum DiskHealthStatus
{
    Unknown = 0,
    Healthy = 1,
    Warning = 2,
    Critical = 3,
    Failed = 4
}

/// <summary>Rolled-up health of a cabinet, used by the fleet dashboard.</summary>
public enum CabinetHealthStatus
{
    Unknown = 0,
    Healthy = 1,
    Warning = 2,
    Critical = 3,
    /// <summary>No check-in inside the configured stale window.</summary>
    Offline = 4
}
