using Mashura.CabinetSupport.Contracts.Common;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Contracts.Audit;

public sealed class AuditEntryDto
{
    public Guid Id { get; set; }
    public DateTime TimestampUtc { get; set; }

    /// <summary>"User", "Agent" or "System" — who the actor was, structurally.</summary>
    public string ActorType { get; set; } = string.Empty;

    public string? ActorId { get; set; }
    public string? ActorDisplayName { get; set; }
    public AuditEventKind EventKind { get; set; }
    public string Action { get; set; } = string.Empty;
    public Guid? CabinetId { get; set; }
    public string? CabinetHostname { get; set; }
    public AuditResult Result { get; set; }
    public string? Reason { get; set; }
    public string? TicketReference { get; set; }
    public Guid? ApprovedByUserId { get; set; }
    public string? Details { get; set; }
    public string? CorrelationId { get; set; }
}

public sealed class AuditQuery : PagedQuery
{
    public Guid? CabinetId { get; set; }
    public string? ActorId { get; set; }
    public AuditEventKind? EventKind { get; set; }
    public AuditResult? Result { get; set; }
    public string? Action { get; set; }
    public DateTime? FromUtc { get; set; }
    public DateTime? ToUtc { get; set; }
}
