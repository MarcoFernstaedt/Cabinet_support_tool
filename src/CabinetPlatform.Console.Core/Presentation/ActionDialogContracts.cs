using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Presentation;

/// <summary>
/// Everything the action dialog needs to describe what is about to happen.
/// </summary>
/// <param name="Catalogue">
/// The server's own description of the action. The dialog quotes it rather than
/// carrying its own copy of the wording, so the console cannot describe an
/// action as safe after the server has reclassified it as disruptive.
/// </param>
/// <param name="CabinetId">Cabinet the action will run against.</param>
/// <param name="Path">
/// The cabinet's full identifying path — client, site, department, name and
/// role. The dialog restates it and will not submit until the operator has
/// confirmed it. A hostname on its own is not an identification: across three
/// and a half thousand client organisations, names repeat constantly, and
/// picking the wrong cabinet is the most likely serious operator error this
/// product has.
/// </param>
/// <param name="Parameters">
/// Parameters already determined by context — the service name from the row the
/// user clicked, for instance. The dialog shows them; it does not invent them,
/// and there is no field anywhere in it for free text the agent would execute.
/// </param>
/// <param name="UserIsLoggedOnToCabinet">
/// Whether the last check-in saw an interactive session. Drives the warning
/// about interrupting clinic work, and the server enforces the same gate.
/// </param>
/// <param name="CallerRole">The signed-in role, for telling the user what the server will require.</param>
public sealed record ActionRequestPrompt(
    ActionCatalogEntryDto Catalogue,
    Guid CabinetId,
    CabinetPath Path,
    IReadOnlyDictionary<string, string> Parameters,
    bool? UserIsLoggedOnToCabinet,
    Role? CallerRole);

/// <summary>
/// What the user supplied in the dialog. Null from the dialog service means
/// they cancelled, which is never treated as a submission.
/// </summary>
/// <param name="Reason">Why, for the audit trail.</param>
/// <param name="TicketReference">The ticket this belongs to.</param>
/// <param name="OverrideSafetyChecks">Whether a Supervisor waived the safety gates.</param>
/// <param name="OverrideReason">Why they waived them.</param>
/// <param name="CabinetConfirmed">
/// That the operator read the cabinet's full path back and agreed it is the one
/// they meant. The dialog will not produce a submission without it.
/// </param>
public sealed record ActionRequestSubmission(
    string Reason,
    string? TicketReference,
    bool OverrideSafetyChecks,
    string? OverrideReason,
    bool CabinetConfirmed = true);

/// <summary>
/// Collects a reason and a ticket reference before an action is submitted.
/// </summary>
/// <remarks>
/// <para>
/// Every action in this product is requested with a stated reason attached. That
/// is not paperwork for its own sake: these cabinets hold controlled substances,
/// and six months later a compliance reviewer reading the audit trail needs to
/// know why someone restarted the dispense controller in the middle of a
/// Tuesday.
/// </para>
/// <para>
/// The implementation must place initial keyboard focus on Cancel, not Confirm.
/// A dialog that appears under a user's in-flight Return keystroke and takes it
/// as consent has not obtained consent.
/// </para>
/// </remarks>
public interface IActionRequestDialog
{
    Task<ActionRequestSubmission?> ShowAsync(ActionRequestPrompt prompt, CancellationToken ct);
}

/// <summary>Whether the approver is approving or denying, and what they are deciding on.</summary>
public sealed record ApprovalDecisionPrompt(ActionRequestView Action, bool IsApproval);

/// <summary>
/// An approver's decision. <see cref="Note"/> is required for a denial — the
/// requester has to be able to find out why — and optional for an approval.
/// </summary>
public sealed record ApprovalDecisionSubmission(string? Note, string? TicketReference);

/// <summary>
/// Confirms an approve or deny decision and collects the note that goes into the
/// audit trail beside it.
/// </summary>
public interface IApprovalDecisionDialog
{
    Task<ApprovalDecisionSubmission?> ShowAsync(ApprovalDecisionPrompt prompt, CancellationToken ct);
}
