using CabinetPlatform.Contracts.Enums;

namespace CabinetPlatform.Server.Domain;

/// <summary>
/// An append-only record of something that happened. These rows may be read in
/// a DEA compliance context, so the table has no update path and no delete
/// path: there is no mutating method on the repository, and the DbContext
/// refuses to save a modified or deleted entry.
///
/// A denial is as much an event as a success. An unauthorised attempt that
/// leaves no trace is the bug this table exists to prevent.
/// </summary>
public class AuditEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public DateTime TimestampUtc { get; set; }

    /// <summary>"User", "Agent", "System" or "Anonymous".</summary>
    public string ActorType { get; set; } = string.Empty;

    /// <summary>
    /// User id, cabinet machine id, or null when the caller could not be
    /// identified at all. Stored as text so a single column can carry either.
    /// </summary>
    public string? ActorId { get; set; }

    /// <summary>Denormalised for readability years later, when the user row may have been renamed.</summary>
    public string? ActorDisplayName { get; set; }

    /// <summary>
    /// Observed or Caused. These are structurally distinct and are never
    /// derived from one another at read time.
    /// </summary>
    public AuditEventKind EventKind { get; set; }

    public string Action { get; set; } = string.Empty;

    public Guid? CabinetId { get; set; }

    /// <summary>Denormalised: the cabinet may be renamed or removed from the fleet later.</summary>
    public string? CabinetHostname { get; set; }

    public AuditResult Result { get; set; }

    public string? Reason { get; set; }

    public string? TicketReference { get; set; }

    /// <summary>Set on approval events. Always a different user than the requester.</summary>
    public Guid? ApprovedByUserId { get; set; }

    /// <summary>
    /// Structured JSON context. Never contains a password, a hash, a token or
    /// a connection string.
    /// </summary>
    public string? Details { get; set; }

    /// <summary>Ties this record to the request's log lines.</summary>
    public string? CorrelationId { get; set; }

    public string? RemoteIpAddress { get; set; }
}
