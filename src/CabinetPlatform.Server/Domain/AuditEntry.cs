using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;

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
    /// <summary>Identifier of the record.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>UTC instant the record was written.</summary>
    public DateTimeOffset TimestampUtc { get; set; }

    /// <summary>What kind of actor the record is attributed to.</summary>
    public ActorType ActorType { get; set; } = ActorType.System;

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

    /// <summary>Which audit event this is, drawn from the fixed catalog.</summary>
    public AuditEvent Event { get; set; }

    /// <summary>
    /// The catalog action the record concerns, or null for the many records
    /// that concern none — a sign-in, a read, a registration decision.
    /// </summary>
    public ActionName? Action { get; set; }

    /// <summary>Cabinet the record concerns, when it concerns one.</summary>
    public Guid? CabinetId { get; set; }

    /// <summary>Denormalised: the cabinet may be renamed or removed from the fleet later.</summary>
    public string? CabinetHostname { get; set; }

    /// <summary>
    /// The cabinet a diagnostic probe targeted. Both ends of a probe are named
    /// on the record, so a reviewer can see which network was reached from
    /// which cabinet.
    /// </summary>
    public Guid? TargetCabinetId { get; set; }

    /// <summary>Denormalised hostname of that target cabinet.</summary>
    public string? TargetCabinetHostname { get; set; }

    /// <summary>Outcome recorded, including refusals.</summary>
    public AuditResult Result { get; set; }

    /// <summary>Justification given, or the reason a request was refused.</summary>
    public string? Reason { get; set; }

    /// <summary>Support ticket the record is associated with, if any.</summary>
    public string? TicketReference { get; set; }

    /// <summary>Batch this record belongs to, when it was part of one.</summary>
    public Guid? BatchId { get; set; }

    /// <summary>Set on approval events. Always a different user than the requester.</summary>
    public Guid? ApprovedByUserId { get; set; }

    /// <summary>
    /// Structured JSON context. Never contains a password, a hash, a token or
    /// a connection string.
    /// </summary>
    public string? Details { get; set; }

    /// <summary>Ties this record to the request's log lines.</summary>
    public string? CorrelationId { get; set; }

    /// <summary>Caller's address, where the request carried one.</summary>
    public string? RemoteIpAddress { get; set; }
}
