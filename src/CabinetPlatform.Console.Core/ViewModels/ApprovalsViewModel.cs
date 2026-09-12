using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// The approval queue: actions waiting on a second person, and the signed-in
/// user's own requests shown beside them, dimmed.
/// </summary>
/// <remarks>
/// <para>
/// The server's <c>pending-approval</c> endpoint already omits the caller's own
/// requests, and refuses self-approval outright if one is submitted anyway. That
/// is the rule and it is enforced there. But a queue that simply does not show
/// your own request teaches a new starter that the system lost it — so this view
/// fetches them separately, lists them dimmed, and says in words why they cannot
/// be approved by the person reading.
/// </para>
/// <para>
/// Making the four-eyes rule legible is the point. It is the most surprising
/// behaviour in the product, and every minute a user spends confused by it is a
/// minute they spend looking for a way around it.
/// </para>
/// </remarks>
public sealed partial class ApprovalsViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly IApprovalDecisionDialog _dialog;
    private readonly ISessionStore _session;
    private readonly TimeProvider _timeProvider;

    public ApprovalsViewModel(
        IApiClient api,
        IApprovalDecisionDialog dialog,
        ISessionStore session,
        ILiveRegionAnnouncer announcer,
        TimeProvider timeProvider)
        : base(announcer)
    {
        _api = api;
        _dialog = dialog;
        _session = session;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// The queue: everything awaiting a decision that this user is eligible to
    /// make, plus their own pending requests, dimmed.
    /// </summary>
    public ObservableCollection<ActionRow> Queue { get; } = new();

    [ObservableProperty]
    private ActionRow? _selectedRequest;

    [ObservableProperty]
    private bool _isForbidden;

    /// <summary>
    /// Actions in the queue this user could actually decide on. This is the
    /// number that belongs on a badge: a count including their own requests
    /// would send them to a queue where every button is greyed out.
    /// </summary>
    public int ActionableCount => Queue.Count(r => r.CanDecide);

    public int OwnRequestCount => Queue.Count(r => r.IsOwnRequest);

    public string QueueSummary
    {
        get
        {
            if (Queue.Count == 0)
            {
                return "Nothing is waiting for approval.";
            }

            string own = OwnRequestCount == 0
                ? string.Empty
                : $" {OwnRequestCount} of these {(OwnRequestCount == 1 ? "is" : "are")} " +
                  "your own request and cannot be approved by you.";

            return $"{ActionableCount} of {Queue.Count} awaiting your decision.{own}";
        }
    }

    public string FourEyesExplanation =>
        "Disruptive actions need two people: one to request, a different one to approve. " +
        "Your own requests are listed here so you can see they arrived, but the approve and " +
        "deny buttons are unavailable on them. The server enforces this regardless of what " +
        "this console shows.";

    public string ForbiddenExplanation =>
        "The approval queue is restricted to Tier 2 and above. The server refused this request, " +
        "which is correct — approving an action is not part of your role.";

    [RelayCommand]
    private async Task RefreshAsync() => await LoadAsync();

    public async Task LoadAsync()
    {
        IsForbidden = false;

        Guid? currentUserId = _session.UserId;

        List<ActionRequestView> approvable = new();
        List<ActionRequestView> ownRequests = new();

        bool loaded = await RunAsync(async ct =>
        {
            PagedResult<ActionRequestView> pendingForMe =
                await _api.GetPendingApprovalsAsync(new PagedQuery { PageSize = 100 }, ct);

            approvable.AddRange(pendingForMe.Items);

            // The caller's own pending requests, which the approvals endpoint
            // deliberately excludes. Fetched from the general list endpoint,
            // which Tier 1 can also reach, then narrowed to this user.
            if (currentUserId is { } userId)
            {
                PagedResult<ActionRequestView> pending = await _api.GetActionsAsync(
                    new ActionQuery { Status = ActionRequestStatus.PendingApproval, PageSize = 100 }, ct);

                ownRequests.AddRange(pending.Items.Where(a => a.RequestedByUserId == userId));
            }
        });

        if (!loaded)
        {
            IsForbidden = LastFailure == ApiFailure.Forbidden;

            Queue.Clear();
            RaiseCountsChanged();
            return;
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        Queue.Clear();

        // Actionable first. The user's own requests sit below, visible but out of
        // the way of the work they can actually do.
        foreach (ActionRequestView request in approvable)
        {
            Queue.Add(new ActionRow(request, currentUserId, nowUtc));
        }

        foreach (ActionRequestView request in ownRequests.OrderBy(r => r.RequestedUtc))
        {
            Queue.Add(new ActionRow(request, currentUserId, nowUtc));
        }

        SelectedRequest = Queue.FirstOrDefault(r => r.CanDecide);

        RaiseCountsChanged();

        Announcer.Announce($"Approval queue loaded. {QueueSummary}");
    }

    private bool CanDecide => SelectedRequest?.CanDecide == true && !IsLoading;

    [RelayCommand(CanExecute = nameof(CanDecide))]
    private async Task ApproveAsync(CancellationToken ct) => await DecideAsync(isApproval: true, ct);

    [RelayCommand(CanExecute = nameof(CanDecide))]
    private async Task DenyAsync(CancellationToken ct) => await DecideAsync(isApproval: false, ct);

    private async Task DecideAsync(bool isApproval, CancellationToken ct)
    {
        if (SelectedRequest is not { CanDecide: true } row)
        {
            return;
        }

        ApprovalDecisionSubmission? submission = await _dialog.ShowAsync(
            new ApprovalDecisionPrompt(row.Request, isApproval), ct);

        if (submission is null)
        {
            return;
        }

        try
        {
            ActionRequestView updated = isApproval
                ? await _api.ApproveActionAsync(
                    row.Id, new ApproveActionRequest
                    {
                        Note = submission.Note,
                        TicketReference = submission.TicketReference
                    }, ct)
                : await _api.DenyActionAsync(
                    row.Id, new DenyActionRequest
                    {
                        // The server requires a reason for a denial and the
                        // dialog will not return without one, so this is never
                        // the empty string in practice.
                        Reason = submission.Note ?? string.Empty,
                        TicketReference = submission.TicketReference
                    }, ct);

            ClearError();

            string verb = isApproval ? "Approved" : "Denied";

            Announcer.AnnounceImportant(
                $"{verb} {updated.Action} on {row.Hostname}. " +
                (isApproval
                    ? "It will be collected by the cabinet's agent on its next check-in."
                    : "It will not run."));

            await LoadAsync();
        }
        catch (ApiException ex)
        {
            Fail(ex);

            // A conflict means somebody else decided first, or the request
            // expired while it was on screen. Reloading is the honest response:
            // leaving a stale row with live buttons invites a second attempt at
            // something already settled.
            if (ex.Failure is ApiFailure.Conflict or ApiFailure.NotFound)
            {
                await LoadAsync();

                // The reload cleared the error, as every load does. Put it back:
                // the row has just vanished from the queue, and without the
                // message the user is left with a disappearance and no reason.
                RestoreError(ex.Failure, ex.Message);
            }
        }
    }

    partial void OnSelectedRequestChanged(ActionRow? value)
    {
        ApproveCommand.NotifyCanExecuteChanged();
        DenyCommand.NotifyCanExecuteChanged();

        if (value is not null)
        {
            Announcer.Announce(value.AccessibleSummary);
        }
    }

    protected override void OnLoadingChanged(bool isLoading)
    {
        ApproveCommand.NotifyCanExecuteChanged();
        DenyCommand.NotifyCanExecuteChanged();
    }

    private void RaiseCountsChanged()
    {
        OnPropertyChanged(nameof(ActionableCount));
        OnPropertyChanged(nameof(OwnRequestCount));
        OnPropertyChanged(nameof(QueueSummary));
        ApproveCommand.NotifyCanExecuteChanged();
        DenyCommand.NotifyCanExecuteChanged();
    }
}
