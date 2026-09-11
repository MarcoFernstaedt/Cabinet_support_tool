using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Enums;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// The reason-and-ticket dialog shown before any action is submitted.
/// </summary>
/// <remarks>
/// <para>
/// There is no field here, and there will be no field here, into which a user
/// types something a cabinet then executes. The parameters are supplied by the
/// section that opened the dialog — a service name taken from the row the user
/// selected — and are shown read-only. The only free text is the reason and the
/// ticket, and neither ever reaches an agent.
/// </para>
/// <para>
/// Both are required by this console even though the server accepts a missing
/// ticket. That is a deliberate tightening rather than an oversight: an action
/// on a controlled-substance cabinet with no ticket behind it is an action
/// nobody can reconstruct six months later.
/// </para>
/// </remarks>
public sealed partial class ActionRequestDialogViewModel : ObservableObject
{
    public ActionRequestDialogViewModel(ActionRequestPrompt prompt)
    {
        Prompt = prompt;

        Parameters = prompt.Parameters
            .Select(p => new ParameterRow(p.Key, p.Value))
            .ToList();
    }

    public ActionRequestPrompt Prompt { get; }

    public string Title => $"{Prompt.Catalogue.DisplayName} — {Prompt.CabinetHostname}";

    public string ActionName => Prompt.Catalogue.DisplayName;
    public string Description => Prompt.Catalogue.Description;
    public string Hostname => Prompt.CabinetHostname;
    public string ClientAndSite => Prompt.ClientAndSite;

    public IReadOnlyList<ParameterRow> Parameters { get; }

    public bool HasParameters => Parameters.Count > 0;

    public bool IsDisruptive => Prompt.Catalogue.IsDisruptive;
    public bool RequiresApproval => Prompt.Catalogue.RequiresApproval;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ValidationMessage))]
    private string _reason = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ValidationMessage))]
    private string _ticketReference = string.Empty;

    /// <summary>
    /// Supervisor-only. Runs a disruptive action despite a logged-on user or
    /// outside the maintenance window. The server checks the role again and
    /// refuses a non-Supervisor regardless of this checkbox.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ValidationMessage),
        nameof(OverrideReasonRequired))]
    private bool _overrideSafetyChecks;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ValidationMessage))]
    private string _overrideReason = string.Empty;

    /// <summary>
    /// Whether the override is worth offering at all. Only a Supervisor may use
    /// it, and only on an action that actually has a safety gate to pass.
    /// </summary>
    public bool CanOfferOverride =>
        Prompt.CallerRole >= UserRole.Supervisor &&
        (Prompt.Catalogue.MaintenanceWindowOnly || Prompt.Catalogue.BlockedIfUserLoggedOn);

    public bool OverrideReasonRequired => OverrideSafetyChecks;

    /// <summary>
    /// What this action will do and what stands in its way, in words, before the
    /// user commits to it.
    /// </summary>
    public IReadOnlyList<string> Warnings
    {
        get
        {
            List<string> warnings = new();

            if (Prompt.Catalogue.IsDisruptive)
            {
                warnings.Add(
                    "This action is disruptive. It interrupts work on the cabinet, and a " +
                    "clinician may be mid-dispense.");
            }

            if (Prompt.Catalogue.RequiresApproval)
            {
                warnings.Add(
                    "A second person must approve this before it runs. You cannot approve it " +
                    "yourself — it will sit in the approval queue until somebody else decides.");
            }

            if (Prompt.Catalogue.MaintenanceWindowOnly)
            {
                warnings.Add(
                    "This action only runs inside the maintenance window. Outside it, the server " +
                    "will refuse the request unless a Supervisor overrides the check.");
            }

            if (Prompt.Catalogue.BlockedIfUserLoggedOn)
            {
                warnings.Add(
                    "This action is refused while anyone is logged on to the cabinet.");
            }

            if (Prompt.Catalogue.BlockedIfUserLoggedOn && Prompt.UserIsLoggedOnToCabinet == true)
            {
                warnings.Add(
                    "Someone is logged on to this cabinet right now, according to its last " +
                    "check-in. Expect the server to refuse this.");
            }

            if (Prompt.Catalogue.BlockedIfUserLoggedOn && Prompt.UserIsLoggedOnToCabinet is null)
            {
                // Unknown is not the same as nobody, and the safer reading is
                // the one that assumes a clinician is there.
                warnings.Add(
                    "Whether anyone is logged on to this cabinet is not known. That is not the " +
                    "same as nobody being logged on, and is treated as unsafe.");
            }

            return warnings;
        }
    }

    public bool HasWarnings => Warnings.Count > 0;

    /// <summary>
    /// Why the confirm button is unavailable, or null. Never silent: a disabled
    /// confirm with no explanation is how a user concludes the dialog is broken.
    /// </summary>
    public string? ValidationMessage
    {
        get
        {
            if (Reason.Trim().Length < 3)
            {
                return "Enter a reason of at least three characters. It goes into the audit trail " +
                       "and is what a reviewer will read months from now.";
            }

            if (string.IsNullOrWhiteSpace(TicketReference))
            {
                return "Enter a ticket reference. Every action on a cabinet is traceable to one.";
            }

            if (OverrideSafetyChecks && OverrideReason.Trim().Length < 3)
            {
                return "Overriding a safety check requires its own stated reason.";
            }

            return null;
        }
    }

    public bool CanSubmit => ValidationMessage is null;

    /// <summary>Builds the submission, or null when the dialog is not valid.</summary>
    public ActionRequestSubmission? BuildSubmission() => CanSubmit
        ? new ActionRequestSubmission(
            Reason.Trim(),
            TicketReference.Trim(),
            OverrideSafetyChecks,
            OverrideSafetyChecks ? OverrideReason.Trim() : null)
        : null;

    /// <summary>
    /// The whole dialog as one announcement, read when it opens, so the
    /// consequence is heard before anything is typed.
    /// </summary>
    public string AccessibleSummary =>
        $"{ActionName} on {Hostname}, {ClientAndSite}. {Description} " +
        (HasParameters
            ? "Parameters: " + string.Join(", ", Parameters.Select(p => $"{p.Key} {p.Value}")) + ". "
            : string.Empty) +
        string.Join(" ", Warnings) +
        " A reason and a ticket reference are required.";

    /// <summary>One read-only parameter, shown so the user can see what they are approving.</summary>
    public sealed record ParameterRow(string Key, string Value);
}
