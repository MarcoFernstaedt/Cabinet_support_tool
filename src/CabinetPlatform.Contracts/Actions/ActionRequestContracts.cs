using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// A support rep asking for one catalogued action on one cabinet.
/// </summary>
/// <remarks>
/// There is no command, script or query field here, and there never will be.
/// Where an action names a target — a service, a port, another cabinet — the
/// value travels in <see cref="Parameters"/> and is validated key by key
/// against that action's allow-list before anything is dispatched.
/// </remarks>
public sealed record CreateActionRequest
{
    /// <summary>The action to request, drawn from the fixed catalog.</summary>
    public required ActionName Action { get; init; }

    /// <summary>Cabinet the action targets.</summary>
    public required Guid CabinetId { get; init; }

    /// <summary>
    /// Named operands for the action. Every key is checked against the catalog
    /// entry's allow-list; an unrecognised key is a rejection.
    /// </summary>
    public IReadOnlyDictionary<string, string> Parameters { get; init; }
        = new Dictionary<string, string>();

    /// <summary>Why the action is being requested, recorded in the audit trail.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket this action belongs to, if any.</summary>
    public string? TicketReference { get; init; }

    /// <summary>
    /// Supervisor-only. Runs a disruptive action despite a logged-on user or
    /// outside the maintenance window. Requires <see cref="OverrideReason"/>.
    /// </summary>
    public bool OverrideSafetyChecks { get; init; }

    /// <summary>Justification for the override, required whenever one is asked for.</summary>
    public string? OverrideReason { get; init; }
}

/// <summary>
/// One action request as the console displays it, with its whole lifecycle.
/// </summary>
/// <remarks>
/// Distinct from <see cref="ActionRequestDto"/>, which is the envelope the
/// agent receives: that one carries what the agent needs to act, this one
/// carries what a person needs to understand what happened and who decided it.
/// </remarks>
public sealed record ActionRequestView
{
    /// <summary>Identifier of the request.</summary>
    public required Guid Id { get; init; }

    /// <summary>The action requested.</summary>
    public required ActionName Action { get; init; }

    /// <summary>Cabinet the action targets.</summary>
    public required Guid CabinetId { get; init; }

    /// <summary>Hostname of that cabinet, for display.</summary>
    /// <remarks>
    /// Never shown on its own. Hostnames repeat across clients, so anything a
    /// person reads to decide what they are about to do reads
    /// <see cref="CabinetPath"/> instead; this field exists for the grid column
    /// that sits beside the rest of the path, not instead of it.
    /// </remarks>
    public string? CabinetHostname { get; init; }

    /// <summary>Client the cabinet belongs to.</summary>
    public string? ClientName { get; init; }

    /// <summary>Site the cabinet sits at.</summary>
    public string? SiteName { get; init; }

    /// <summary>
    /// The cabinet's full identifying path: client, site, department, name and
    /// role.
    /// </summary>
    /// <remarks>
    /// Carried on every action so that an approver, who did not raise the
    /// request and has no other context for it, can see exactly whose cabinet
    /// they are about to authorise work on.
    /// </remarks>
    public CabinetPath? CabinetPath { get; init; }

    /// <summary>Identifier of the requesting user.</summary>
    public required Guid RequestedByUserId { get; init; }

    /// <summary>Display name of the requesting user.</summary>
    public string? RequestedByDisplayName { get; init; }

    /// <summary>UTC instant the request was raised.</summary>
    public required DateTimeOffset RequestedUtc { get; init; }

    /// <summary>Named operands supplied with the request.</summary>
    public IReadOnlyDictionary<string, string> Parameters { get; init; }
        = new Dictionary<string, string>();

    /// <summary>
    /// Cabinet this action probes, for the cabinet-to-cabinet diagnostics, or
    /// <see langword="null"/> for every other action.
    /// </summary>
    public Guid? TargetCabinetId { get; init; }

    /// <summary>Hostname of the probed cabinet, for display.</summary>
    public string? TargetCabinetHostname { get; init; }

    /// <summary>The probed cabinet's full identifying path, where there is one.</summary>
    public CabinetPath? TargetCabinetPath { get; init; }

    /// <summary>Justification the requester gave.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the request is associated with, if any.</summary>
    public string? TicketReference { get; init; }

    /// <summary>Where the request stands.</summary>
    public required ActionRequestStatus Status { get; init; }

    /// <summary>The second person who approved it, or <see langword="null"/>.</summary>
    public Guid? ApprovedByUserId { get; init; }

    /// <summary>Display name of the approver.</summary>
    public string? ApprovedByDisplayName { get; init; }

    /// <summary>UTC instant of the approval decision.</summary>
    public DateTimeOffset? ApprovedUtc { get; init; }

    /// <summary>UTC instant the request was handed to the agent.</summary>
    public DateTimeOffset? DispatchedUtc { get; init; }

    /// <summary>UTC instant an outcome was recorded.</summary>
    public DateTimeOffset? CompletedUtc { get; init; }

    /// <summary>How the agent said it ended, once it has said so.</summary>
    public ActionStatus? ResultStatus { get; init; }

    /// <summary>Agent-reported outcome detail. Display only.</summary>
    public string? ResultOutput { get; init; }

    /// <summary>
    /// Structured data an on-demand action returned, as a JSON document: an
    /// event log view's records, a process list, a network change's outcome.
    /// Null for every action that collects nothing.
    /// </summary>
    /// <remarks>
    /// Data the agent read, never anything anybody executes. The console
    /// deserialises it into the grid for the section that asked; the server
    /// stores it verbatim and does not interpret it.
    /// </remarks>
    public string? CollectedData { get; init; }

    /// <summary>When the request stops being dispatchable.</summary>
    public DateTimeOffset? ExpiresUtc { get; init; }

    /// <summary>Whether a Supervisor waived the safety checks.</summary>
    public required bool SafetyChecksOverridden { get; init; }

    /// <summary>Justification for that waiver.</summary>
    public string? OverrideReason { get; init; }

    /// <summary>
    /// Batch this request was expanded from, or <see langword="null"/> when it
    /// was raised on its own.
    /// </summary>
    public Guid? BatchId { get; init; }

    /// <summary>
    /// Reserved. The person at the cabinet who confirmed that actuating its
    /// hardware was safe.
    /// </summary>
    /// <remarks>
    /// Always null in this build. It exists because an actuation that is
    /// authorised remotely and performed with nobody standing at the cabinet is
    /// the failure mode the whole design is arranged to prevent, and the field
    /// that records the second, physical confirmation should already be part of
    /// the record's shape before anything can set it.
    /// </remarks>
    public Guid? OnSiteConfirmedByUserId { get; init; }

    /// <summary>Reserved. UTC instant of that on-site confirmation. Always null here.</summary>
    public DateTimeOffset? OnSiteConfirmedUtc { get; init; }
}

/// <summary>Filter over the action list.</summary>
public sealed record ActionQuery : PagedQuery
{
    /// <summary>Restrict to one cabinet.</summary>
    public Guid? CabinetId { get; init; }

    /// <summary>Restrict to one lifecycle state.</summary>
    public ActionRequestStatus? Status { get; init; }

    /// <summary>Restrict to the requests expanded from one batch.</summary>
    public Guid? BatchId { get; init; }
}

/// <summary>An approver's decision to allow an action.</summary>
public sealed record ApproveActionRequest
{
    /// <summary>
    /// Optional note from the approver. The approval is recorded whether or not
    /// this is supplied; the identity of the approver is not optional.
    /// </summary>
    public string? Note { get; init; }

    /// <summary>Support ticket the approval is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}

/// <summary>An approver's decision to refuse an action.</summary>
public sealed record DenyActionRequest
{
    /// <summary>Why it was refused. Required, and written to the audit trail.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the refusal is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}

/// <summary>
/// Asking for the one-click test of a cabinet's link to its site's sync
/// cabinet.
/// </summary>
/// <remarks>
/// It names no target and no address. The server resolves both from the
/// cabinet's site, which is the whole point: a rep selects a cabinet, not an
/// address, and cannot select the wrong one.
/// </remarks>
public sealed record TestSyncLinkRequest
{
    /// <summary>Why the link is being tested. Optional; a default is recorded if omitted.</summary>
    public string? Reason { get; init; }

    /// <summary>Support ticket the test is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}
