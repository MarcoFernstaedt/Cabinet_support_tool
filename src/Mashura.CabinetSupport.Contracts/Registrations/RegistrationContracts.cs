using System.ComponentModel.DataAnnotations;
using Mashura.CabinetSupport.Contracts.Common;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Contracts.Registrations;

public sealed class PendingRegistrationDto
{
    public Guid Id { get; set; }
    public string MachineId { get; set; } = string.Empty;
    public string Hostname { get; set; } = string.Empty;
    public string? OsVersion { get; set; }
    public string? AgentVersion { get; set; }
    public DateTime FirstSeenUtc { get; set; }
    public DateTime LastSeenUtc { get; set; }
    public RegistrationStatus Status { get; set; }
    public Guid? DecidedByUserId { get; set; }
    public DateTime? DecidedUtc { get; set; }
}

public sealed class RegistrationQuery : PagedQuery
{
    public RegistrationStatus? Status { get; set; }
}

/// <summary>
/// Approval is where an anonymous machine becomes a known cabinet. The client,
/// site and department come from the approving Supervisor, never from the
/// agent — an agent must not be able to name the clinic it claims to serve.
/// </summary>
public sealed class ApproveRegistrationRequest
{
    [Required, StringLength(255, MinimumLength = 1)]
    public string ClientName { get; set; } = string.Empty;

    [Required, StringLength(255, MinimumLength = 1)]
    public string SiteName { get; set; } = string.Empty;

    [StringLength(255)]
    public string? DepartmentName { get; set; }

    [StringLength(128)]
    public string? Model { get; set; }

    [StringLength(128)]
    public string? SerialNumber { get; set; }

    [StringLength(64)]
    public string? TicketReference { get; set; }
}

public sealed class RejectRegistrationRequest
{
    [Required, StringLength(1000, MinimumLength = 3)]
    public string Reason { get; set; } = string.Empty;

    [StringLength(64)]
    public string? TicketReference { get; set; }
}
