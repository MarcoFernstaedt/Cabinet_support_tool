using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// The action and approval dialogs: what they require, what they warn about, and
/// what they refuse to submit.
/// </summary>
public sealed class DialogViewModelTests
{
    private static ActionCatalogEntryDto Reboot() => new()
    {
        Action = ActionName.RebootMachine,
        DisplayName = "Reboot machine",
        Description = "Restarts the cabinet PC.",
        MinimumRole = Role.Tier2,
        RequiresApproval = true,
        IsDisruptive = true,
        TimeoutSeconds = 900,
        AllowedParameterKeys = new[] { "delaySeconds" },
        MaintenanceWindowOnly = true,
        BlockedIfUserLoggedOn = true,
        TargetsAnotherCabinet = false,
        Batchable = true,
        BatchSupervisorThreshold = 10,
        MaximumBatchSize = 100
    };

    private static ActionCatalogEntryDto Scan() => new()
    {
        Action = ActionName.ScanForUpdates,
        DisplayName = "Scan for updates",
        Description = "Queries Windows Update. Installs nothing.",
        MinimumRole = Role.Tier1,
        RequiresApproval = false,
        IsDisruptive = false,
        TimeoutSeconds = 600,
        AllowedParameterKeys = Array.Empty<string>(),
        MaintenanceWindowOnly = false,
        BlockedIfUserLoggedOn = false,
        TargetsAnotherCabinet = false,
        Batchable = true,
        BatchSupervisorThreshold = 50,
        MaximumBatchSize = 500
    };

    private static ActionRequestDialogViewModel Dialog(
        ActionCatalogEntryDto catalogue,
        bool? loggedOn = false,
        Role role = Role.Tier2,
        IReadOnlyDictionary<string, string>? parameters = null) =>
        new(new ActionRequestPrompt(
            catalogue,
            CabinetId,
            Path(),
            parameters ?? new Dictionary<string, string>(),
            loggedOn,
            role));

    private static readonly Guid CabinetId = Guid.NewGuid();

    /// <summary>
    /// The full identifying path the dialog restates and requires confirming.
    /// </summary>
    /// <param name="ambiguous">
    /// Whether another cabinet in the set this was chosen from shares the name.
    /// </param>
    private static CabinetPath Path(bool ambiguous = false) => new()
    {
        CabinetId = CabinetId,
        ClientName = "Northgate Veterinary",
        SiteName = "Main Surgery",
        SiteId = Guid.NewGuid(),
        DepartmentName = "Dispensary",
        CabinetName = "CUBEX-NG-01",
        Role = CabinetRole.Satellite,
        SerialNumber = "NG-0041",
        HostnameIsAmbiguous = ambiguous,
    };

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

        // Still not submittable. The last question, and the one this console
        // adds on top of what the server requires, is whether this is the
        // cabinet the operator meant.
        Assert.False(dialog.CanSubmit);
        Assert.Contains("Confirm", dialog.ValidationMessage!, StringComparison.OrdinalIgnoreCase);

        dialog.CabinetConfirmed = true;

        Assert.True(dialog.CanSubmit);
        Assert.Null(dialog.ValidationMessage);

        ActionRequestSubmission submission = dialog.BuildSubmission()!;
        Assert.Equal("Patch level check", submission.Reason);
        Assert.Equal("SUP-1042", submission.TicketReference);
        Assert.False(submission.OverrideSafetyChecks);
        Assert.True(submission.CabinetConfirmed);
    }

    /// <summary>
    /// The dialog restates the whole path, and will not submit until the
    /// operator has agreed to it.
    /// </summary>
    /// <remarks>
    /// With three and a half thousand client organisations and seven thousand
    /// cabinets, picking the wrong one is the most likely serious operator
    /// error this product has. This dialog is the last point at which it can be
    /// caught, and a checkbox is cheap next to a reboot on another client's
    /// dispensing cabinet.
    /// </remarks>
    [Fact]
    public void The_dialog_restates_the_full_path_and_requires_it_to_be_confirmed()
    {
        ActionRequestDialogViewModel dialog = Dialog(Scan());

        Assert.Contains("Northgate Veterinary", dialog.CabinetPathDisplay, StringComparison.Ordinal);
        Assert.Contains("Main Surgery", dialog.CabinetPathDisplay, StringComparison.Ordinal);
        Assert.Contains("Dispensary", dialog.CabinetPathDisplay, StringComparison.Ordinal);
        Assert.Contains("CUBEX-NG-01", dialog.CabinetPathDisplay, StringComparison.Ordinal);

        Assert.Equal("CUBEX-NG-01", dialog.CabinetName);
        Assert.Contains("Satellite", dialog.CabinetRoleLabel, StringComparison.Ordinal);
        Assert.Contains("NG-0041", dialog.SerialNumber, StringComparison.Ordinal);

        // The whole identification is spoken, not only the name.
        Assert.Contains("Northgate Veterinary", dialog.AccessibleSummary, StringComparison.Ordinal);
        Assert.Contains("confirm the cabinet", dialog.AccessibleSummary, StringComparison.OrdinalIgnoreCase);

        // Unticked when the dialog opens. A pre-ticked confirmation confirms
        // nothing.
        Assert.False(dialog.CabinetConfirmed);

        dialog.Reason = "Patch level check";
        dialog.TicketReference = "SUP-1042";

        Assert.False(dialog.CanSubmit);
        Assert.Null(dialog.BuildSubmission());
    }

    /// <summary>
    /// When the chosen cabinet shares its name with another in the same result
    /// set, the dialog says so in words.
    /// </summary>
    /// <remarks>
    /// Two identically-named rows distinguished by something the eye skips is
    /// exactly how the wrong cabinet gets picked, and a colour says nothing to
    /// a screen reader.
    /// </remarks>
    [Fact]
    public void A_duplicated_cabinet_name_is_warned_about_in_words()
    {
        var dialog = new ActionRequestDialogViewModel(new ActionRequestPrompt(
            Scan(),
            CabinetId,
            Path(ambiguous: true),
            new Dictionary<string, string>(),
            false,
            Role.Tier1));

        Assert.True(dialog.CabinetNameIsAmbiguous);

        Assert.Contains(
            dialog.Warnings,
            w => w.Contains("same name", StringComparison.OrdinalIgnoreCase));

        Assert.Contains("same name", dialog.CabinetConfirmationQuestion, StringComparison.OrdinalIgnoreCase);
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
        Assert.False(Dialog(Reboot(), role: Role.Tier2).CanOfferOverride);
        Assert.True(Dialog(Reboot(), role: Role.Supervisor).CanOfferOverride);

        // Scan has no safety gate to override, so there is nothing to offer even
        // to a Supervisor.
        Assert.False(Dialog(Scan(), role: Role.Supervisor).CanOfferOverride);
    }

    [Fact]
    public void An_override_requires_its_own_stated_reason()
    {
        ActionRequestDialogViewModel dialog = Dialog(Reboot(), role: Role.Supervisor);

        dialog.Reason = "Cabinet unresponsive, clinic closed";
        dialog.TicketReference = "SUP-2002";
        dialog.CabinetConfirmed = true;

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
        ActionRequestDialogViewModel dialog = Dialog(Reboot(), role: Role.Supervisor);

        dialog.Reason = "Cabinet unresponsive";
        dialog.TicketReference = "SUP-2003";
        dialog.CabinetConfirmed = true;
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

        ParameterRow row = Assert.Single(dialog.Parameters);
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

    private static ActionRequestView PendingRequest() => new()
    {
        Id = Guid.NewGuid(),
        Action = ActionName.StopService,
        CabinetId = Guid.NewGuid(),
        CabinetHostname = "CUBEX-NG-02",
        ClientName = "Northgate Veterinary",
        SiteName = "Main Surgery",
        RequestedByUserId = Guid.NewGuid(),
        RequestedByDisplayName = "A. Requester",
        RequestedUtc = DateTimeOffset.UtcNow.AddMinutes(-6),
        Reason = "Dispense controller wedged",
        TicketReference = "SUP-2001",
        Status = ActionRequestStatus.PendingApproval,
        SafetyChecksOverridden = false,
        ExpiresUtc = DateTimeOffset.UtcNow.AddMinutes(24),
        Parameters = new Dictionary<string, string> { ["serviceName"] = "MashuraDispenseController" }
    };

    [Fact]
    public void Denying_requires_a_reason_and_approving_does_not()
    {
        var deny = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: false), DateTimeOffset.UtcNow);

        Assert.False(deny.CanConfirm);
        Assert.Contains("requester needs to know", deny.ValidationMessage!, StringComparison.OrdinalIgnoreCase);

        deny.Note = "Clinic is mid-session";
        Assert.True(deny.CanConfirm);
        Assert.Equal("Clinic is mid-session", deny.BuildSubmission()!.Note);

        var approve = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: true), DateTimeOffset.UtcNow);

        Assert.True(approve.CanConfirm);
        Assert.Null(approve.ValidationMessage);
        Assert.Null(approve.BuildSubmission()!.Note);
    }

    [Fact]
    public void The_decision_dialog_shows_the_requesters_own_words_and_the_consequence()
    {
        var approve = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: true), DateTimeOffset.UtcNow);

        Assert.Equal("Approve", approve.ConfirmLabel);
        Assert.Contains("Dispense controller wedged", approve.AccessibleSummary);
        Assert.Contains("A. Requester", approve.AccessibleSummary);
        Assert.Contains("SUP-2001", approve.AccessibleSummary);
        Assert.Contains("interrupt", approve.Consequence, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("serviceName: MashuraDispenseController", approve.Row.Parameters);

        var deny = new ApprovalDecisionDialogViewModel(
            new ApprovalDecisionPrompt(PendingRequest(), IsApproval: false), DateTimeOffset.UtcNow);

        Assert.Equal("Deny", deny.ConfirmLabel);
        Assert.Contains("stops this permanently", deny.Consequence, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("required", deny.NoteLabel, StringComparison.OrdinalIgnoreCase);
    }
}
