using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// What an operator has to read and agree to before an action runs across many
/// cabinets.
/// </summary>
/// <remarks>
/// The whole design of this dialog is to stop somebody agreeing to a blast
/// radius they did not read: every cabinet named, the count stated, and the
/// count typed back before anything can be submitted.
/// </remarks>
public sealed class BatchDialogTests
{
    [Fact]
    public void The_operator_must_type_the_count_back_before_anything_can_be_submitted()
    {
        BatchActionDialogViewModel dialog = Dialog(cabinetCount: 37);

        Assert.False(dialog.CanSubmit);
        Assert.Contains("Type 37", dialog.ValidationMessage!, StringComparison.Ordinal);

        dialog.Reason = "Rolling out the January cumulative update.";
        dialog.TicketReference = "SUP-9001";

        // Still not enough. The count is the thing being agreed to.
        Assert.False(dialog.CanSubmit);

        dialog.ConfirmedCount = "36";
        Assert.False(dialog.CanSubmit);
        Assert.Contains("names 37", dialog.ValidationMessage!, StringComparison.Ordinal);

        dialog.ConfirmedCount = "37";
        Assert.True(dialog.CanSubmit);
        Assert.Null(dialog.ValidationMessage);
    }

    [Fact]
    public void The_submission_carries_the_frozen_list_and_the_confirmed_count()
    {
        // Identifiers, not a filter. A filter re-evaluated on the server would
        // let a batch approved this afternoon act on cabinets that joined the
        // fleet this evening.
        BatchActionDialogViewModel dialog = Ready(cabinetCount: 4);

        CreateBatchActionRequest? submission = dialog.BuildSubmission();

        Assert.NotNull(submission);
        Assert.Equal(ActionName.RebootMachine, submission!.Action);
        Assert.Equal(4, submission.CabinetIds.Count);
        Assert.Equal(4, submission.ConfirmedCabinetCount);
        Assert.Equal(submission.CabinetIds.Count, submission.ConfirmedCabinetCount);
        Assert.Equal(submission.CabinetIds.Distinct().Count(), submission.CabinetIds.Count);
    }

    [Fact]
    public void An_incomplete_dialog_builds_nothing()
    {
        Assert.Null(Dialog(cabinetCount: 3).BuildSubmission());
    }

    [Fact]
    public void Every_cabinet_is_named_with_its_client_and_site()
    {
        // The mis-selected clinic is the failure this list exists to catch, and
        // a hostname alone does not catch it.
        BatchActionDialogViewModel dialog = Dialog(cabinetCount: 3);

        Assert.Equal(3, dialog.Targets.Count);
        Assert.All(dialog.Targets, t => Assert.Contains("—", t.ClientAndSite, StringComparison.Ordinal));
        Assert.All(dialog.Targets, t => Assert.False(string.IsNullOrWhiteSpace(t.Hostname)));
    }

    [Fact]
    public void A_batch_above_the_servers_cap_is_refused_here_rather_than_truncated()
    {
        // The server rejects an over-sized batch outright. Saying so before
        // submission is the difference between an operator narrowing their
        // selection and an operator believing a rejected batch ran.
        BatchActionDialogViewModel dialog = Ready(cabinetCount: 120, maximumBatchSize: 100);

        Assert.False(dialog.CanSubmit);
        Assert.Contains("cap of 100", dialog.ValidationMessage!, StringComparison.Ordinal);
        Assert.Contains(
            dialog.Warnings,
            w => w.Contains("rather than act on part of it", StringComparison.Ordinal));
    }

    [Fact]
    public void A_batch_past_the_threshold_says_it_needs_a_supervisor()
    {
        // Approval thresholds scale with blast radius. A requester who learns
        // that only at the approval queue has already told a clinic a time.
        Assert.False(Dialog(cabinetCount: 9, supervisorThreshold: 10).RequiresSupervisorApproval);

        BatchActionDialogViewModel large = Dialog(cabinetCount: 10, supervisorThreshold: 10);

        Assert.True(large.RequiresSupervisorApproval);
        Assert.Contains(
            large.Warnings,
            w => w.Contains("Supervisor's approval", StringComparison.Ordinal));
    }

    [Fact]
    public void Cabinets_that_will_be_skipped_are_named_before_submission_not_reported_after()
    {
        // Ruling 11: a batched reboot skips any cabinet whose last check-in says
        // somebody is logged on, and any whose check-in could not tell. An
        // operator who expects fifty reboots and gets forty-seven needs to know
        // which three and why at the moment they decide.
        var cabinets = new[]
        {
            Cabinet("CAB-IDLE", loggedOn: false),
            Cabinet("CAB-BUSY", loggedOn: true),
            Cabinet("CAB-UNKNOWN", loggedOn: null),
            Cabinet("CAB-RETIRED", loggedOn: false, isActive: false),
        };

        var dialog = new BatchActionDialogViewModel(
            new BatchActionPrompt(Reboot(), cabinets, NoParameters, Role.Supervisor));

        Assert.Equal(4, dialog.TargetCount);
        Assert.Equal(1, dialog.ExpectedCount);

        Assert.Equal(
            new[] { "CAB-BUSY", "CAB-RETIRED", "CAB-UNKNOWN" },
            dialog.Skipped.Select(t => t.Hostname).OrderBy(h => h, StringComparer.Ordinal));

        // The unknown one is skipped for the same reason the busy one is. Not
        // knowing whether a clinician is at the cabinet is not the same as
        // knowing nobody is.
        BatchTargetRow unknown = dialog.Targets.Single(t => t.Hostname == "CAB-UNKNOWN");

        Assert.True(unknown.WillBeSkipped(Reboot()));
        Assert.Equal("Not reported", unknown.LoggedOn);

        Assert.Contains(
            dialog.Warnings,
            w => w.Contains("not knowing is not the same", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_batch_spanning_several_clients_says_so()
    {
        var cabinets = new[]
        {
            Cabinet("CAB-A", clientName: "Northgate Veterinary"),
            Cabinet("CAB-B", clientName: "Riverside Animal Hospital"),
        };

        var dialog = new BatchActionDialogViewModel(
            new BatchActionPrompt(Reboot(), cabinets, NoParameters, Role.Supervisor));

        Assert.Equal(2, dialog.ClientCount);
        Assert.Contains(
            dialog.Warnings,
            w => w.Contains("2 different clients", StringComparison.Ordinal));
    }

    [Fact]
    public void The_warnings_say_that_a_partial_failure_is_neither_rolled_back_nor_retried()
    {
        Assert.Contains(
            Dialog(cabinetCount: 5).Warnings,
            w => w.Contains("not rolled back and is not retried", StringComparison.Ordinal));
    }

    [Fact]
    public void A_maintenance_window_action_says_each_cabinet_is_judged_in_its_own_zone()
    {
        Assert.Contains(
            Dialog(cabinetCount: 5).Warnings,
            w => w.Contains("its own time", StringComparison.Ordinal));
    }

    private static readonly IReadOnlyDictionary<string, string> NoParameters =
        new Dictionary<string, string>();

    private static ActionCatalogEntryDto Reboot(
        int? supervisorThreshold = 25, int? maximumBatchSize = 500) => new()
    {
        Action = ActionName.RebootMachine,
        DisplayName = "Reboot machine",
        Description = "Restarts the cabinet PC.",
        MinimumRole = Role.Tier2,
        RequiresApproval = true,
        IsDisruptive = true,
        TimeoutSeconds = 900,
        AllowedParameterKeys = new[] { ActionParameterKeys.DelaySeconds },
        MaintenanceWindowOnly = true,
        BlockedIfUserLoggedOn = true,
        TargetsAnotherCabinet = false,
        Batchable = true,
        BatchSupervisorThreshold = supervisorThreshold,
        MaximumBatchSize = maximumBatchSize,
    };

    private static BatchActionDialogViewModel Dialog(
        int cabinetCount, int? supervisorThreshold = 25, int? maximumBatchSize = 500) =>
        new(new BatchActionPrompt(
            Reboot(supervisorThreshold, maximumBatchSize),
            Enumerable.Range(1, cabinetCount).Select(i => Cabinet($"CAB-{i:D3}")).ToList(),
            NoParameters,
            Role.Supervisor));

    private static BatchActionDialogViewModel Ready(
        int cabinetCount, int? supervisorThreshold = 25, int? maximumBatchSize = 500)
    {
        BatchActionDialogViewModel dialog = Dialog(cabinetCount, supervisorThreshold, maximumBatchSize);

        dialog.Reason = "Rolling out the January cumulative update.";
        dialog.TicketReference = "SUP-9001";
        dialog.ConfirmedCount = cabinetCount.ToString();

        return dialog;
    }

    private static CabinetSummary Cabinet(
        string hostname,
        bool? loggedOn = false,
        bool isActive = true,
        string clientName = "Northgate Veterinary") => new()
    {
        Id = Guid.NewGuid(),
        MachineId = $"machine-{hostname}",
        Hostname = hostname,
        ClientName = clientName,
        SiteName = "Main Surgery",
        SiteId = Guid.NewGuid(),
        Role = CabinetRole.Satellite,
        IsActive = isActive,
        Health = CabinetHealthStatus.Healthy,
        WorstDiskHealth = DiskHealthStatus.Healthy,
        AnyUserLoggedOn = loggedOn,
    };
}
