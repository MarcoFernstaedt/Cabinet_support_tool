using System.ComponentModel.DataAnnotations;
using Mashura.CabinetSupport.Contracts.Common;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Contracts.Actions;

/// <summary>
/// The client-visible description of one catalogue entry. The console uses it
/// to grey out buttons; the server never reads it back. The authoritative
/// catalogue lives in server code and cannot be edited at runtime.
/// </summary>
public sealed class ActionCatalogEntryDto
{
    public CabinetActionType Action { get; set; }
    public string DisplayName { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public UserRole MinimumRole { get; set; }
    public bool RequiresApproval { get; set; }
    public bool IsDisruptive { get; set; }
    public int TimeoutSeconds { get; set; }
    public IReadOnlyList<string> AllowedParameterKeys { get; set; } = Array.Empty<string>();
    public bool MaintenanceWindowOnly { get; set; }
    public bool BlockedIfUserLoggedOn { get; set; }
}

/// <summary>
/// A request to run a catalogued action on one cabinet.
/// There is no command, script or query field here, and there never will be.
/// </summary>
public sealed class CreateActionRequest
{
    [Required]
    public CabinetActionType Action { get; set; }

    [Required]
    public Guid CabinetId { get; set; }

    /// <summary>
    /// Every key is checked against the catalogue entry's allow-list. An
    /// unrecognised key is a rejection, not a silently dropped field.
    /// </summary>
    public Dictionary<string, string> Parameters { get; set; } = new();

    [Required, StringLength(1000, MinimumLength = 3)]
    public string Reason { get; set; } = string.Empty;

    [StringLength(64)]
    public string? TicketReference { get; set; }

    /// <summary>
    /// Supervisor-only. Runs a disruptive action despite a logged-on user or
    /// outside the maintenance window. Requires <see cref="OverrideReason"/>.
    /// </summary>
    public bool OverrideSafetyChecks { get; set; }

    [StringLength(1000)]
    public string? OverrideReason { get; set; }
}

public sealed class ActionRequestDto
{
    public Guid Id { get; set; }
    public CabinetActionType Action { get; set; }
    public Guid CabinetId { get; set; }
    public string CabinetHostname { get; set; } = string.Empty;
    public string ClientName { get; set; } = string.Empty;
    public string SiteName { get; set; } = string.Empty;
    public Guid RequestedByUserId { get; set; }
    public string RequestedByDisplayName { get; set; } = string.Empty;
    public DateTime RequestedUtc { get; set; }
    public IReadOnlyDictionary<string, string> Parameters { get; set; } = new Dictionary<string, string>();
    public string Reason { get; set; } = string.Empty;
    public string? TicketReference { get; set; }
    public ActionRequestStatus Status { get; set; }
    public Guid? ApprovedByUserId { get; set; }
    public string? ApprovedByDisplayName { get; set; }
    public DateTime? ApprovedUtc { get; set; }
    public DateTime? DispatchedUtc { get; set; }
    public DateTime? CompletedUtc { get; set; }
    public ActionResultStatus? ResultStatus { get; set; }
    public string? ResultOutput { get; set; }
    public DateTime? ExpiresUtc { get; set; }
    public bool SafetyChecksOverridden { get; set; }
    public string? OverrideReason { get; set; }
}

public sealed class ActionQuery : PagedQuery
{
    public Guid? CabinetId { get; set; }
    public ActionRequestStatus? Status { get; set; }
}

public sealed class ApproveActionRequest
{
    /// <summary>
    /// Optional note from the approver. The approval itself is recorded whether
    /// or not this is supplied; the identity of the approver is not optional.
    /// </summary>
    [StringLength(1000)]
    public string? Note { get; set; }

    [StringLength(64)]
    public string? TicketReference { get; set; }
}

public sealed class DenyActionRequest
{
    [Required, StringLength(1000, MinimumLength = 3)]
    public string Reason { get; set; } = string.Empty;

    [StringLength(64)]
    public string? TicketReference { get; set; }
}
