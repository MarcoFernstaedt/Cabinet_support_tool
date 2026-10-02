using System.ComponentModel.DataAnnotations;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Registrations;

/// <summary>An agent waiting in the pending queue, as a Supervisor sees it.</summary>
public sealed record PendingRegistrationDto
{
    /// <summary>Identifier of the pending registration.</summary>
    public required Guid Id { get; init; }

    /// <summary>Stable hardware-derived machine identifier, hashed.</summary>
    public required string MachineId { get; init; }

    /// <summary>Hostname the agent reported, as a human-readable hint.</summary>
    public required string Hostname { get; init; }

    /// <summary>Operating system version the agent reported.</summary>
    public string? OsVersion { get; init; }

    /// <summary>Version of the agent asking to join.</summary>
    public string? AgentVersion { get; init; }

    /// <summary>UTC instant the machine first announced itself.</summary>
    public required DateTimeOffset FirstSeenUtc { get; init; }

    /// <summary>UTC instant of its most recent attempt.</summary>
    public required DateTimeOffset LastSeenUtc { get; init; }

    /// <summary>Where it stands.</summary>
    public required RegistrationStatus Status { get; init; }

    /// <summary>Who decided, once somebody has.</summary>
    public Guid? DecidedByUserId { get; init; }

    /// <summary>UTC instant of that decision.</summary>
    public DateTimeOffset? DecidedUtc { get; init; }
}

/// <summary>Filter over the registration queue.</summary>
public sealed record RegistrationQuery : PagedQuery
{
    /// <summary>Restrict to one lifecycle state.</summary>
    public RegistrationStatus? Status { get; init; }
}

/// <summary>
/// Approval is where an anonymous machine becomes a known cabinet.
/// </summary>
/// <remarks>
/// The client, site, department and role all come from the approving
/// Supervisor, never from the agent — an agent must not be able to name the
/// clinic it claims to serve, nor promote itself to its site's sync cabinet.
/// </remarks>
public sealed record ApproveRegistrationRequest
{
    /// <summary>Optional operator label, independent of hostname and immutable identity.</summary>
    [MaxLength(120)]
    public string? FriendlyName { get; init; }

    /// <summary>Client this cabinet belongs to.</summary>
    [Required, MaxLength(255)]
    public required string ClientName { get; init; }

    /// <summary>Site within that client.</summary>
    [Required, MaxLength(255)]
    public required string SiteName { get; init; }

    /// <summary>Department within that site, when the client uses them.</summary>
    public string? DepartmentName { get; init; }

    /// <summary>
    /// This cabinet's part in its site's topology. A site may hold exactly one
    /// <see cref="CabinetRole.Sync"/> cabinet; approving a second as Sync is
    /// refused rather than silently demoting the first.
    /// </summary>
    [EnumDataType(typeof(CabinetRole))]
    public required CabinetRole Role { get; init; }

    /// <summary>Cabinet model, when known.</summary>
    public string? Model { get; init; }

    /// <summary>Cabinet serial number, when known.</summary>
    public string? SerialNumber { get; init; }

    /// <summary>Supervisor's optional approval reason, recorded in the audit.</summary>
    [MaxLength(2000), RegularExpression(@"[\s\S]*\S[\s\S]*")]
    public string? ApprovalReason { get; init; }

    /// <summary>Support ticket the approval is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}

/// <summary>A Supervisor refusing a pending agent.</summary>
public sealed record RejectRegistrationRequest
{
    /// <summary>Why it was refused. Required, and audited.</summary>
    [Required, MaxLength(2000)]
    public required string Reason { get; init; }

    /// <summary>Support ticket the refusal is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}
