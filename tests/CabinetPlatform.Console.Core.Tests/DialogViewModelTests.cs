using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Enums;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// The action and approval dialogs: what they require, what they warn about, and
/// what they refuse to submit.
/// </summary>
public sealed class DialogViewModelTests
{
    private static ActionCatalogEntryDto Reboot() => new()
    {
        Action = CabinetActionType.RebootMachine,
        DisplayName = "Reboot machine",
        Description = "Restarts the cabinet PC.",
        MinimumRole = UserRole.Tier2,
        RequiresApproval = true,
        IsDisruptive = true,
        TimeoutSeconds = 900,
        AllowedParameterKeys = new[] { "delaySeconds" },
        MaintenanceWindowOnly = true,
        BlockedIfUserLoggedOn = true
    };

    private static ActionCatalogEntryDto Scan() => new()
    {
        Action = CabinetActionType.ScanForUpdates,
        DisplayName = "Scan for updates",
        Description = "Queries Windows Update. Installs nothing.",
        MinimumRole = UserRole.Tier1,
        RequiresApproval = false,
        IsDisruptive = false,
        TimeoutSeconds = 600,
        AllowedParameterKeys = Array.Empty<string>(),
        MaintenanceWindowOnly = false,
        BlockedIfUserLoggedOn = false
    };

    private static ActionRequestDialogViewModel Dialog(
        ActionCatalogEntryDto catalogue,
        bool? loggedOn = false,
        UserRole role = UserRole.Tier2,
        IReadOnlyDictionary<string, string>? parameters = null) =>
        new(new ActionRequestPrompt(
            catalogue,
            Guid.NewGuid(),
            "CUBEX-NG-01",
            "Northgate Veterinary — Main Surgery",
            parameters ?? new Dictionary<string, string>(),
            loggedOn,
            role));

    [Fact]
    public void A_reason_and_a_ticket_are_both_required_before_anything_can_be_submitted()
    {
        ActionRequestDialogViewModel dialog = Dialog(Scan());

        Assert.False(dialog.CanSubmit);
        Assert.Contains("reason", dialog.ValidationMessage!, StringComparison.OrdinalIgnoreCase);
        Assert.Null(dialog.BuildSubmission());

        dialog.Reason = "Patch level check";

        Assert.False(dialog.CanSubmit);
        Assert.Contains("ticket", dialog.ValidationMessage!, StringComparison.OrdinalIgnoreCase);

        dialog.TicketReference = "SUP-1042";

        Assert.True(dialog.CanSubmit);
        Assert.Null(dialog.ValidationMessage);

        ActionRequestSubmission submission = dialog.BuildSubmission()!;
        Assert.Equal("Patch level check", submission.Reason);
        Assert.Equal("SUP-1042", submission.TicketReference);
        Assert.False(submission.OverrideSafetyChecks);
    }

    [Fact]
    public void A_whitespace_only_reason_does_not_count_as_a_reason()
    {
        ActionRequestDialogViewModel dialog = Dialog(Scan());

        dialog.Reason = "   ";
        dialog.TicketReference = "SUP-1042";

        Assert.False(dialog.CanSubmit);
    }

    [Fact]
    public void A_disruptive_action_states_every_consequence_before_it_is_submitted()
    {
        ActionRequestDialogViewModel dialog = Dialog(Reboot());

        string warnings = string.Join(" ", dialog.Warnings);

        Assert.True(dialog.HasWarnings);
        Assert.Contains("disruptive", warnings, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("second person must approve", warnings, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("maintenance window", warnings, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("refused while anyone is logged on", warnings, StringComparison.OrdinalIgnoreCase);

        // And all of it is in the summary read out when the dialog opens.
        Assert.Contains("disruptive", dialog.AccessibleSummary, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("CUBEX-NG-01", dialog.AccessibleSummary);
    }

    [Fact]
    public void A_logged_on_user_is_warned_about_specifically()
    {
        ActionRequestDialogViewModel dialog = Dialog(Reboot(), loggedOn: true);

        Assert.Contains(dialog.Warnings, w =>
            w.Contains("logged on to this cabinet right now", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Unknown is not the same as nobody, and the dialog must not let a reader
    /// infer that it is.
    /// </summary>
    [Fact]
    public void An_unknown_logon_state_is_treated_as_unsafe_rather_than_as_nobody()
    {
        ActionRequestDialogViewModel dialog = Dialog(Reboot(), loggedOn: null);

        Assert.Contains(dialog.Warnings, w =>
            w.Contains("not the same as nobody", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void The_override_is_offered_only_to_a_supervisor_and_only_where_there_is_a_gate()
    {
        Assert.False(Dialog(Reboot(), role: UserRole.Tier2).CanOfferOverride);
        Assert.True(Dialog(Reboot(), role: UserRole.Supervisor).CanOfferOverride);

        // Scan has no safety gate to override, so there is nothing to offer even
        // to a Supervisor.
        Assert.False(Dialog(Scan(), role: UserRole.Supervisor).CanOfferOverride);
    }

    [Fact]
    public void An_override_requires_its_own_stated_reason()
    {
        ActionRequestDialogViewModel dialog = Dialog(Reboot(), role: UserRole.Supervisor);

        dialog.Reason = "Cabinet unresponsive, clinic closed";
        dialog.TicketReference = "SUP-2002";

        Assert.True(dialog.CanSubmit);

        dialog.OverrideSafetyChecks = true;

        Assert.False(dialog.CanSubmit);
        Assert.Contains("stated reason", dialog.ValidationMessage!, StringComparison.OrdinalIgnoreCase);

        dialog.OverrideReason = "Confirmed with the practice manager that nobody is on site";

        Assert.True(dialog.CanSubmit);

        ActionRequestSubmission submission = dialog.BuildSubmission()!;
        Assert.True(submission.OverrideSafetyChecks);
        Assert.Equal(
            "Confirmed with the practice manager that nobody is on site",
            submission.OverrideReason);
    }

    /// <summary>
    /// An override reason typed and then abandoned must not be sent. Otherwise a
    /// request carries an override justification for an override that is not
    /// happening, which is the kind of record that destroys trust in the trail.
    /// </summary>
    [Fact]
    public void An_override_reason_is_dropped_when_the_override_is_unticked()
    {
        ActionRequestDialogViewModel dialog = Dialog(Reboot(), role: UserRole.Supervisor);

        dialog.Reason = "Cabinet unresponsive";
        dialog.TicketReference = "SUP-2003";
        dialog.OverrideSafetyChecks = true;
        dialog.OverrideReason = "Nobody on site";
        dialog.OverrideSafetyChecks = false;

        ActionRequestSubmission submission = dialog.BuildSubmission()!;

        Assert.False(submission.OverrideSafetyChecks);
        Assert.Null(submission.OverrideReason);
    }

    [Fact]
    public void Parameters_are_shown_read_only_and_come_only_from_the_calling_context()
    {
        ActionRequestDialogViewModel dialog = Dialog(
            Scan(),
            parameters: new Dictionary<string, string> { ["serviceName"] = "MashuraDispenseController" });

        Assert.True(dialog.HasParameters);

        ActionRequestDialogViewModel.ParameterRow row = Assert.Single(dialog.Parameters);
        Assert.Equal("serviceName", row.Key);
        Assert.Equal("MashuraDispenseController", row.Value);

        // The submission carries no parameters of its own: the invoker supplies
        // them from the catalogue-checked prompt, and the dialog never invents
        // one.
        dialog.Reason = "Service wedged";
        dialog.TicketReference = "SUP-1";

        Assert.Contains("serviceName", dialog.AccessibleSummary);
    }

    // --- Approval decision ------------------------------------------------

    private static ActionRequestDto PendingRequest() => new()
    {
        Id = Guid.NewGuid(),
        Action = CabinetActionType.StopService,
        CabinetId = Guid.NewGuid(),
        CabinetHostname = "CUBEX-NG-02",
        ClientName = "Northgate Veterinary",
        SiteName = "Main Surgery",
        RequestedByUserId = Guid.NewGuid(),
        RequestedByDisplayName = "A. Requester",
        RequestedUtc = DateTime.UtcNow.AddMinutes(-6),
        Reason = "Dispense controller wedged",
        TicketReference = "SUP-2001",
        Status = ActionRequestStatus.PendingApproval,
        ExpiresUtc = DateTime.UtcNow.AddMinutes(24),
        Parameters = new Dictionary<string, string> { ["serviceName"] = "MashuraDispenseController" }
    };

    [Fact]
    public void Denying_requires_a_reason_and_approving_does_not()
    {
        var deny = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: false), DateTime.UtcNow);

        Assert.False(deny.CanConfirm);
        Assert.Contains("requester needs to know", deny.ValidationMessage!, StringComparison.OrdinalIgnoreCase);

        deny.Note = "Clinic is mid-session";
        Assert.True(deny.CanConfirm);
        Assert.Equal("Clinic is mid-session", deny.BuildSubmission()!.Note);

        var approve = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: true), DateTime.UtcNow);

        Assert.True(approve.CanConfirm);
        Assert.Null(approve.ValidationMessage);
        Assert.Null(approve.BuildSubmission()!.Note);
    }

    [Fact]
    public void The_decision_dialog_shows_the_requesters_own_words_and_the_consequence()
    {
        var approve = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: true), DateTime.UtcNow);

        Assert.Equal("Approve", approve.ConfirmLabel);
        Assert.Contains("Dispense controller wedged", approve.AccessibleSummary);
        Assert.Contains("A. Requester", approve.AccessibleSummary);
        Assert.Contains("SUP-2001", approve.AccessibleSummary);
        Assert.Contains("interrupt", approve.Consequence, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("serviceName: MashuraDispenseController", approve.Row.Parameters);

        var deny = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: false), DateTime.UtcNow);

        Assert.Equal("Deny", deny.ConfirmLabel);
        Assert.Contains("stops this permanently", deny.Consequence, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("required", deny.NoteLabel, StringComparison.OrdinalIgnoreCase);
    }
}
