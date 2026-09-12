using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Server.Domain;

/// <summary>
/// A request to run one catalogued action on one cabinet.
/// </summary>
/// <remarks>
/// There is no command, script or SQL column here by design. The action is an
/// enum resolved against a catalog defined in code, and the parameters are
/// checked key-by-key against that catalog's allow-list before anything is ever
/// handed to an agent.
/// </remarks>
public class ActionRequest
{
    /// <summary>Identifier of the request.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>The action requested.</summary>
    public ActionName Action { get; set; }

    /// <summary>Cabinet the action runs on.</summary>
    public Guid CabinetId { get; set; }

    /// <summary>Navigation to that cabinet.</summary>
    public Cabinet? Cabinet { get; set; }

    /// <summary>
    /// For the cabinet-to-cabinet diagnostics, the cabinet being probed. The
    /// server resolves its address; the console names only the cabinet.
    /// </summary>
    public Guid? TargetCabinetId { get; set; }

    /// <summary>
    /// True when the probe target sits at a different site of the same client.
    /// Same-client cross-site probing is permitted but explicit, and audited
    /// distinctly from the same-site case.
    /// </summary>
    public bool IsCrossSiteTarget { get; set; }

    /// <summary>The batch this request was expanded from, when it came from one.</summary>
    public Guid? BatchId { get; set; }

    /// <summary>Who asked for it.</summary>
    public Guid RequestedByUserId { get; set; }

    /// <summary>UTC instant it was raised.</summary>
    public DateTimeOffset RequestedUtc { get; set; }

    /// <summary>Allow-listed keys only, serialised after validation.</summary>
    public string ParametersJson { get; set; } = "{}";

    /// <summary>Justification the requester gave.</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>Support ticket the request is associated with, if any.</summary>
    public string? TicketReference { get; set; }

    /// <summary>Where the request stands.</summary>
    public ActionRequestStatus Status { get; set; } = ActionRequestStatus.PendingApproval;

    /// <summary>
    /// Never equal to <see cref="RequestedByUserId"/>. The four-eyes rule is
    /// enforced with an explicit check at approval time, not merely by
    /// convention or by hiding the button.
    /// </summary>
    public Guid? ApprovedByUserId { get; set; }

    /// <summary>UTC instant of the approval decision.</summary>
    public DateTimeOffset? ApprovedUtc { get; set; }

    /// <summary>UTC instant the request was handed to the agent.</summary>
    public DateTimeOffset? DispatchedUtc { get; set; }

    /// <summary>UTC instant an outcome was recorded.</summary>
    public DateTimeOffset? CompletedUtc { get; set; }

    /// <summary>How the agent said it ended.</summary>
    public ActionStatus? ResultStatus { get; set; }

    /// <summary>Agent-reported outcome detail, truncated. Evidence, never instructions.</summary>
    public string? ResultOutput { get; set; }

    /// <summary>Process exit code, where the action produced one.</summary>
    public int? ExitCode { get; set; }

    /// <summary>UTC instant the agent began the action.</summary>
    public DateTimeOffset? StartedUtc { get; set; }

    /// <summary>
    /// Structured data an on-demand collector returned — an event log window or
    /// a process list — as JSON. Null for every other action.
    /// </summary>
    public string? CollectedDataJson { get; set; }

    /// <summary>
    /// After this instant the action is dead. An approval nobody collected must
    /// not fire hours later against a cabinet whose state has moved on.
    /// </summary>
    public DateTimeOffset? ExpiresUtc { get; set; }

    /// <summary>
    /// Reserved. The person standing at the cabinet who confirmed that
    /// actuating its hardware was safe.
    /// </summary>
    /// <remarks>
    /// Always null in this build, and nothing sets it. It exists now because
    /// the failure this product must never have is an actuation authorised from
    /// a desk with nobody at the cabinet, and the column that records the
    /// physical half of that authorisation belongs in the record's shape before
    /// any code can write to it.
    /// </remarks>
    public Guid? OnSiteConfirmedByUserId { get; set; }

    /// <summary>Reserved. UTC instant of that on-site confirmation.</summary>
    public DateTimeOffset? OnSiteConfirmedUtc { get; set; }

    /// <summary>Set when a Supervisor ran a disruptive action past its safety checks.</summary>
    public bool SafetyChecksOverridden { get; set; }

    /// <summary>Required whenever <see cref="SafetyChecksOverridden"/> is set.</summary>
    public string? OverrideReason { get; set; }

    /// <summary>
    /// Optimistic concurrency token guarding the status transition.
    /// </summary>
    /// <remarks>
    /// Two approvers pressing Approve at the same instant is the normal case,
    /// not an edge case. This is what makes exactly one of them win and the
    /// other receive a clear "already approved" rather than a second approval
    /// silently overwriting the first.
    /// </remarks>
    public byte[]? RowVersion { get; set; }
}

/// <summary>
/// One action requested across several cabinets at once.
/// </summary>
/// <remarks>
/// <para>
/// Batching is modelled explicitly so that approval and audit see the true
/// blast radius. A console looping over single requests would present a
/// Supervisor with fifty one-cabinet decisions instead of one fifty-cabinet
/// decision, which is the same information arranged so nobody can act on it.
/// </para>
/// <para>
/// Targets are frozen at request time in <see cref="BatchActionTarget"/> rows.
/// There is no stored filter for the server to re-evaluate, so a filter that
/// matches more cabinets tomorrow cannot widen a batch approved today.
/// </para>
/// </remarks>
public class BatchActionRequest
{
    /// <summary>Identifier tying every expanded request together.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>The single action requested across the batch.</summary>
    public ActionName Action { get; set; }

    /// <summary>Allow-listed keys only, applied identically to every target.</summary>
    public string ParametersJson { get; set; } = "{}";

    /// <summary>Who asked for it.</summary>
    public Guid RequestedByUserId { get; set; }

    /// <summary>UTC instant it was raised.</summary>
    public DateTimeOffset RequestedUtc { get; set; }

    /// <summary>Justification the requester gave.</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>Support ticket the batch is associated with, if any.</summary>
    public string? TicketReference { get; set; }

    /// <summary>Where the batch as a whole stands.</summary>
    public BatchActionStatus Status { get; set; } = BatchActionStatus.PendingApproval;

    /// <summary>Who approved it. Never the requester.</summary>
    public Guid? ApprovedByUserId { get; set; }

    /// <summary>UTC instant of the approval decision.</summary>
    public DateTimeOffset? ApprovedUtc { get; set; }

    /// <summary>Why it was refused, when it was.</summary>
    public string? DenialReason { get; set; }

    /// <summary>How many cabinets the batch names.</summary>
    public int TargetCount { get; set; }

    /// <summary>The frozen target list.</summary>
    public ICollection<BatchActionTarget> Targets { get; set; } = new List<BatchActionTarget>();

    /// <summary>Optimistic concurrency token guarding the status transition.</summary>
    public byte[]? RowVersion { get; set; }
}

/// <summary>One cabinet's place in a batch.</summary>
public class BatchActionTarget
{
    /// <summary>Identifier of the row.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Batch this target belongs to.</summary>
    public Guid BatchId { get; set; }

    /// <summary>Navigation to that batch.</summary>
    public BatchActionRequest? Batch { get; set; }

    /// <summary>Cabinet this row names.</summary>
    public Guid CabinetId { get; set; }

    /// <summary>Navigation to that cabinet.</summary>
    public Cabinet? Cabinet { get; set; }

    /// <summary>
    /// The individual request this cabinet's work became, or null when the
    /// cabinet was skipped before expansion.
    /// </summary>
    public Guid? ActionRequestId { get; set; }

    /// <summary>
    /// Why this cabinet was skipped rather than dispatched to — somebody signed
    /// in, an unreadable logged-on flag, or a closed maintenance window. Null
    /// when it was not skipped. A skip is reported, never silently dropped.
    /// </summary>
    public string? SkippedReason { get; set; }
}
