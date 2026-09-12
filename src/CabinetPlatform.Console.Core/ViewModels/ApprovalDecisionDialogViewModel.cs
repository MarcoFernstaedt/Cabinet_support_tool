using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// Confirms an approve or deny decision and collects the note recorded beside it.
/// </summary>
/// <remarks>
/// A denial requires a reason; an approval does not. The asymmetry is not
/// laziness: the requester has to be able to find out why their request was
/// refused, whereas an approval that says nothing beyond who approved it is
/// already a complete record.
/// </remarks>
public sealed partial class ApprovalDecisionDialogViewModel : ObservableObject
{
    public ApprovalDecisionDialogViewModel(ApprovalDecisionPrompt prompt, DateTimeOffset nowUtc)
    {
        Prompt = prompt;
        Row = new ActionRow(prompt.Action, currentUserId: null, nowUtc);
    }

    public ApprovalDecisionPrompt Prompt { get; }

    /// <summary>The request being decided, formatted for display.</summary>
    public ActionRow Row { get; }

    public bool IsApproval => Prompt.IsApproval;

    public string Title => IsApproval
        ? $"Approve {Row.ActionName} on {Row.Hostname}"
        : $"Deny {Row.ActionName} on {Row.Hostname}";

    public string ConfirmLabel => IsApproval ? "Approve" : "Deny";

    public string NoteLabel => IsApproval
        ? "Note (optional)"
        : "Reason for denying (required)";

    public string Consequence => IsApproval
        ? "Once approved, the cabinet's agent will collect this on its next check-in and run it. " +
          "If it is disruptive, that will interrupt work on the cabinet."
        : "Denying stops this permanently. The requester will need to raise a new request if they " +
          "still need the action.";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanConfirm), nameof(ValidationMessage))]
    private string _note = string.Empty;

    [ObservableProperty]
    private string _ticketReference = string.Empty;

    public string? ValidationMessage => !IsApproval && Note.Trim().Length < 3
        ? "Enter a reason of at least three characters. The requester needs to know why this was " +
          "refused."
        : null;

    public bool CanConfirm => ValidationMessage is null;

    public ApprovalDecisionSubmission? BuildSubmission() => CanConfirm
        ? new ApprovalDecisionSubmission(
            string.IsNullOrWhiteSpace(Note) ? null : Note.Trim(),
            string.IsNullOrWhiteSpace(TicketReference) ? null : TicketReference.Trim())
        : null;

    public string AccessibleSummary =>
        $"{Title}. Requested by {Row.RequestedBy} at {Row.RequestedAt}. " +
        $"Their stated reason: {Row.Reason}. Ticket {Row.Ticket}. {Consequence}";
}
