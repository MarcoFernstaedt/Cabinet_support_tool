using System.Text.Json.Serialization;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Audit;

/// <summary>
/// One record in the audit trail. Every action writes one, including actions
/// that were denied.
/// </summary>
/// <remarks>
/// This platform sits next to a DEA chain-of-custody system, so audit quality
/// is a functional requirement. A record says who acted, what they did, on
/// what, whether it was allowed, and — through
/// <see cref="EventKind"/> — whether the platform merely observed something
/// or actually caused it.
/// </remarks>
public sealed record AuditEntryDto
{
    /// <summary>Identifier of this audit record.</summary>
    public required Guid Id { get; init; }

    /// <summary>UTC instant the record was written.</summary>
    public required DateTimeOffset TimestampUtc { get; init; }

    /// <summary>What kind of actor is responsible for the record.</summary>
    public required ActorType ActorType { get; init; }

    /// <summary>
    /// Identifier of the actor: a user id, an agent's machine id, or the name
    /// of the server process for system-originated records.
    /// </summary>
    public required string ActorId { get; init; }

    /// <summary>The actor's display name, when one is known. For reading, not for filtering.</summary>
    public string? ActorDisplayName { get; init; }

    /// <summary>
    /// Whether the platform observed this or caused it. Required, never
    /// nullable, and written by whoever creates the record — never inferred at
    /// read time from the shape of the other fields.
    /// </summary>
    public required AuditEventKind EventKind { get; init; }

    /// <summary>Which audit event this record is, drawn from the fixed catalog.</summary>
    public required AuditEvent Event { get; init; }

    /// <summary>
    /// The action this record concerns, or <see langword="null"/> for records
    /// that are not about an action, such as an observation or a sign-in.
    /// </summary>
    public ActionName? Action { get; init; }

    /// <summary>
    /// Cabinet the record concerns, or <see langword="null"/> for records with
    /// no cabinet context, such as a sign-in or a pending-agent decision.
    /// </summary>
    public Guid? CabinetId { get; init; }

    /// <summary>Hostname of that cabinet at the time, for reading the trail without a join.</summary>
    public string? CabinetHostname { get; init; }

    /// <summary>
    /// The cabinet a diagnostic probe targeted, for the cabinet-to-cabinet
    /// actions. Both ends of a probe are named on the record.
    /// </summary>
    public Guid? TargetCabinetId { get; init; }

    /// <summary>Hostname of that target cabinet.</summary>
    public string? TargetCabinetHostname { get; init; }

    /// <summary>Outcome recorded for this entry, including refusals.</summary>
    public required AuditResult Result { get; init; }

    /// <summary>
    /// Why: the justification supplied with a request, or the reason a request
    /// was denied.
    /// </summary>
    public string? Reason { get; init; }

    /// <summary>Support ticket the record is associated with, if any.</summary>
    public string? TicketReference { get; init; }

    /// <summary>
    /// The second person who approved a disruptive action, or
    /// <see langword="null"/> when the action did not require approval. It is
    /// never the same person as the requester.
    /// </summary>
    public Guid? ApprovedByUserId { get; init; }

    /// <summary>Batch this record belongs to, when it was part of one.</summary>
    public Guid? BatchId { get; init; }

    /// <summary>
    /// Additional structured context as a JSON document, for example the
    /// service name that was restarted or the counters behind an observation.
    /// It carries no command text, no credentials and no biometric data.
    /// </summary>
    public string? Details { get; init; }

    /// <summary>
    /// Identifier tying every record written while serving one request
    /// together, and to the server's own logs.
    /// </summary>
    public string? CorrelationId { get; init; }
}

/// <summary>
/// What kind of actor an audit record is attributed to.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ActorType
{
    /// <summary>A signed-in support user.</summary>
    User = 1,

    /// <summary>An agent running on a cabinet PC.</summary>
    Agent = 2,

    /// <summary>The platform itself, acting without a person, such as a scheduled evaluation.</summary>
    System = 3,

    /// <summary>
    /// An unauthenticated caller. A failed sign-in and a request refused before
    /// authentication have no identity to attribute, and saying so is more
    /// honest than attributing them to the server.
    /// </summary>
    Anonymous = 4,
}

/// <summary>
/// Whether the platform noticed something or made something happen.
/// </summary>
/// <remarks>
/// These are structurally distinct kinds of record, not two ways of wording
/// the same thing. "The service was found stopped" and "we stopped the
/// service" must never be told apart only by reading their prose.
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AuditEventKind
{
    /// <summary>
    /// The platform observed a state or an event it did not bring about, such
    /// as a service found stopped or an authentication event reported by the
    /// cabinet.
    /// </summary>
    Observed = 1,

    /// <summary>
    /// The platform caused a change, such as restarting a service or rebooting
    /// a machine, including attempts that were denied or that failed.
    /// </summary>
    Caused = 2,
}

/// <summary>
/// Outcome recorded on an audit entry.
/// </summary>
/// <remarks>
/// These numbers are load-bearing: they are persisted. Session 3's server was
/// written against <c>Denied = 2, Failure = 3</c>, the opposite of this, and a
/// migration remaps any row written under that numbering. Do not renumber.
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AuditResult
{
    /// <summary>The action or observation completed as intended.</summary>
    Success = 1,

    /// <summary>The action was permitted but did not succeed.</summary>
    Failure = 2,

    /// <summary>The action was refused. Denials are audited exactly like anything else.</summary>
    Denied = 3,
}

/// <summary>Filter over the audit trail.</summary>
public sealed record AuditQuery : HistoryQuery
{
    /// <summary>Restrict to records about one cabinet.</summary>
    public Guid? CabinetId { get; init; }

    /// <summary>Restrict to one actor.</summary>
    public string? ActorId { get; init; }

    /// <summary>Restrict to observations or to changes.</summary>
    public AuditEventKind? EventKind { get; init; }

    /// <summary>Restrict to one outcome.</summary>
    public AuditResult? Result { get; init; }

    /// <summary>Restrict to one audit event.</summary>
    public AuditEvent? Event { get; init; }

    /// <summary>Restrict to records about one catalog action.</summary>
    public ActionName? Action { get; init; }

    /// <summary>Restrict to the records written for one batch.</summary>
    public Guid? BatchId { get; init; }
}
