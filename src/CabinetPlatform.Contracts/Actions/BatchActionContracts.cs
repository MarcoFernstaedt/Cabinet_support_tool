using System.Text.Json.Serialization;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// A request to run one action, with one parameter set, across an explicit list
/// of cabinets.
/// </summary>
/// <remarks>
/// <para>
/// This exists so that approval and audit see the true blast radius. A console
/// that looped over single requests would present a Supervisor with fifty
/// separate one-cabinet decisions instead of one fifty-cabinet decision, which
/// is the same information arranged so that nobody can act on it.
/// </para>
/// <para>
/// Targets are named, never described. There is no filter here that the server
/// re-evaluates later: the console resolves a filter into cabinet ids, shows
/// the operator that list and its count, and sends the ids. A filter that
/// matches more cabinets tomorrow cannot widen a batch approved today.
/// </para>
/// </remarks>
public sealed record CreateBatchActionRequest
{
    /// <summary>The single action every target will be asked to perform.</summary>
    public required ActionName Action { get; init; }

    /// <summary>
    /// The cabinets to act on, resolved by the console and frozen here. The
    /// server rejects an empty list and a list above the configured cap.
    /// </summary>
    public required IReadOnlyList<Guid> CabinetIds { get; init; }

    /// <summary>
    /// The count the operator confirmed on screen. The server checks it against
    /// <see cref="CabinetIds"/> and rejects a mismatch, so an operator cannot
    /// confirm one number and submit another.
    /// </summary>
    public required int ConfirmedCabinetCount { get; init; }

    /// <summary>Named operands, applied identically to every target.</summary>
    public IReadOnlyDictionary<string, string> Parameters { get; init; }
        = new Dictionary<string, string>();

    /// <summary>Why the batch is being requested, recorded against every expanded request.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the batch belongs to, if any.</summary>
    public string? TicketReference { get; init; }
}

/// <summary>
/// A batch as the console displays it, with the state of each cabinet in it.
/// </summary>
/// <remarks>
/// A batch that half-succeeds must be legible. Every expanded request keeps its
/// own status, its own result and its own audit rows; this view is the index
/// over them, not a summary that replaces them.
/// </remarks>
public sealed record BatchActionView
{
    /// <summary>Identifier tying every expanded request together.</summary>
    public required Guid Id { get; init; }

    /// <summary>The action requested across the batch.</summary>
    public required ActionName Action { get; init; }

    /// <summary>Identifier of the requesting user.</summary>
    public required Guid RequestedByUserId { get; init; }

    /// <summary>Display name of the requesting user.</summary>
    public string? RequestedByDisplayName { get; init; }

    /// <summary>UTC instant the batch was raised.</summary>
    public required DateTimeOffset RequestedUtc { get; init; }

    /// <summary>Justification the requester gave.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the batch is associated with, if any.</summary>
    public string? TicketReference { get; init; }

    /// <summary>Named operands applied to every target.</summary>
    public IReadOnlyDictionary<string, string> Parameters { get; init; }
        = new Dictionary<string, string>();

    /// <summary>Where the batch as a whole stands.</summary>
    public required BatchActionStatus Status { get; init; }

    /// <summary>The second person who approved it, or <see langword="null"/>.</summary>
    public Guid? ApprovedByUserId { get; init; }

    /// <summary>Display name of the approver.</summary>
    public string? ApprovedByDisplayName { get; init; }

    /// <summary>UTC instant of the approval decision.</summary>
    public DateTimeOffset? ApprovedUtc { get; init; }

    /// <summary>Why it was refused, when it was.</summary>
    public string? DenialReason { get; init; }

    /// <summary>How many cabinets the batch names.</summary>
    public required int TargetCount { get; init; }

    /// <summary>Per-cabinet state, one row per target.</summary>
    public IReadOnlyList<BatchActionTargetView> Targets { get; init; }
        = Array.Empty<BatchActionTargetView>();
}

/// <summary>One cabinet's place in a batch.</summary>
public sealed record BatchActionTargetView
{
    /// <summary>Cabinet this row concerns.</summary>
    public required Guid CabinetId { get; init; }

    /// <summary>Hostname of that cabinet, for display.</summary>
    public string? CabinetHostname { get; init; }

    /// <summary>Site the cabinet sits at.</summary>
    public string? SiteName { get; init; }

    /// <summary>
    /// The individual request this cabinet's work became, or
    /// <see langword="null"/> when the cabinet was skipped before expansion.
    /// </summary>
    public Guid? ActionRequestId { get; init; }

    /// <summary>Where that individual request stands.</summary>
    public ActionRequestStatus? Status { get; init; }

    /// <summary>How the agent said it ended, once it has said so.</summary>
    public ActionStatus? ResultStatus { get; init; }

    /// <summary>
    /// Why this cabinet was skipped rather than dispatched to — somebody signed
    /// in, an unreadable logged-on flag, or a closed maintenance window.
    /// <see langword="null"/> when it was not skipped.
    /// </summary>
    public string? SkippedReason { get; init; }
}

/// <summary>Where a batch stands as a whole.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BatchActionStatus
{
    /// <summary>Raised and waiting for approval.</summary>
    PendingApproval = 1,

    /// <summary>Approved and expanded into individual requests.</summary>
    Approved = 2,

    /// <summary>Refused. No request was expanded and nothing was dispatched.</summary>
    Denied = 3,

    /// <summary>Every expanded request has reached a terminal state.</summary>
    Completed = 4,
}

/// <summary>Filter over the batch list.</summary>
public sealed record BatchActionQuery : PagedQuery
{
    /// <summary>Restrict to one lifecycle state.</summary>
    public BatchActionStatus? Status { get; init; }
}
