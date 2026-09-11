using Mashura.CabinetSupport.Console.Core.Api;
using Mashura.CabinetSupport.Contracts.Actions;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Console.Core.Presentation;

/// <summary>The outcome of asking for an action, as the UI needs to see it.</summary>
public sealed record ActionInvocationResult(
    bool Submitted,
    ActionRequestDto? Request,
    string? FailureMessage,
    bool WasCancelledByUser)
{
    public static ActionInvocationResult Cancelled { get; } = new(false, null, null, true);

    public static ActionInvocationResult Failed(string message) => new(false, null, message, false);

    public static ActionInvocationResult Succeeded(ActionRequestDto request) => new(true, request, null, false);
}

/// <summary>
/// The one path from "the user clicked an action button" to "the server has the
/// request".
/// </summary>
/// <remarks>
/// <para>
/// Every action in every section goes through here: show the dialog, collect the
/// reason and ticket, submit, then announce the outcome to assistive technology.
/// Eight sections each doing their own version of that would give eight slightly
/// different behaviours, and the one that quietly skipped the announcement would
/// be found by a user, not by us.
/// </para>
/// <para>
/// It deliberately does not decide whether the action is permitted. It reads the
/// catalogue to label and disable buttons and to warn about approval, and then
/// submits and reports whatever the server says. If the two ever disagree, the
/// server is right.
/// </para>
/// </remarks>
public sealed class ActionInvoker
{
    private readonly IApiClient _api;
    private readonly IActionRequestDialog _dialog;
    private readonly ILiveRegionAnnouncer _announcer;
    private readonly ISessionStore _session;

    public ActionInvoker(
        IApiClient api,
        IActionRequestDialog dialog,
        ILiveRegionAnnouncer announcer,
        ISessionStore session)
    {
        _api = api;
        _dialog = dialog;
        _announcer = announcer;
        _session = session;
    }

    public async Task<ActionInvocationResult> InvokeAsync(
        ActionCatalogEntryDto catalogue,
        Guid cabinetId,
        string cabinetHostname,
        string clientAndSite,
        IReadOnlyDictionary<string, string>? parameters,
        bool? userIsLoggedOnToCabinet,
        CancellationToken ct)
    {
        var prompt = new ActionRequestPrompt(
            catalogue,
            cabinetId,
            cabinetHostname,
            clientAndSite,
            parameters ?? new Dictionary<string, string>(),
            userIsLoggedOnToCabinet,
            _session.Role);

        ActionRequestSubmission? submission = await _dialog.ShowAsync(prompt, ct);

        if (submission is null)
        {
            return ActionInvocationResult.Cancelled;
        }

        var request = new CreateActionRequest
        {
            Action = catalogue.Action,
            CabinetId = cabinetId,
            Reason = submission.Reason,
            TicketReference = submission.TicketReference,
            OverrideSafetyChecks = submission.OverrideSafetyChecks,
            OverrideReason = submission.OverrideReason
        };

        foreach (KeyValuePair<string, string> parameter in prompt.Parameters)
        {
            request.Parameters[parameter.Key] = parameter.Value;
        }

        try
        {
            ActionRequestDto created = await _api.CreateActionAsync(request, ct);

            _announcer.AnnounceImportant(DescribeOutcome(catalogue, cabinetHostname, created));

            return ActionInvocationResult.Succeeded(created);
        }
        catch (ApiException ex)
        {
            // The server's refusal wording is written for a support engineer and
            // is more specific than anything the console could say — which role
            // is required, which parameter was rejected, why the safety gate
            // held. It is shown as-is.
            _announcer.AnnounceImportant($"{catalogue.DisplayName} was refused. {ex.Message}");
            return ActionInvocationResult.Failed(ex.Message);
        }
    }

    /// <summary>
    /// Says what actually happened, including whether the action is now waiting
    /// on a second person. A user who is told only "submitted" will go looking
    /// for a reboot that has not happened and will not happen until someone
    /// approves it.
    /// </summary>
    private static string DescribeOutcome(
        ActionCatalogEntryDto catalogue, string hostname, ActionRequestDto created) =>
        created.Status == ActionRequestStatus.PendingApproval
            ? $"{catalogue.DisplayName} requested on {hostname}. " +
              "It is now waiting for a second person to approve it, and will not run until they do."
            : $"{catalogue.DisplayName} requested on {hostname}. Status: " +
              $"{StatusPresentation.ForAction(created.Status).Label}.";
}
