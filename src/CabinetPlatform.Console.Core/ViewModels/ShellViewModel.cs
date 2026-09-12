using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>Which top-level view the main window is showing.</summary>
public enum ShellView
{
    Cabinets,
    Approvals
}

/// <summary>Why the main window is asking for a sign-in.</summary>
public enum SignInReason
{
    /// <summary>The user chose to sign out.</summary>
    SignedOut,

    /// <summary>The token expired or was rejected mid-session.</summary>
    SessionExpired
}

/// <summary>
/// The main window: the cabinet list, the detail tabs, and the approvals queue.
/// </summary>
/// <remarks>
/// Also the one place that reacts to an expired token. Every screen reports
/// <see cref="ObservableViewModelBase.RequiresReauthentication"/> the same way,
/// and the shell watches for it and asks for a new sign-in — rather than each
/// screen deciding for itself and one of them forgetting.
/// </remarks>
public sealed partial class ShellViewModel : ObservableObject
{
    private readonly ISessionStore _session;
    private readonly ILiveRegionAnnouncer _announcer;

    public ShellViewModel(
        CabinetListViewModel cabinets,
        MachineTabViewModel machine,
        CabinetTabViewModel cabinet,
        AuditTabViewModel audit,
        FleetTabViewModel fleet,
        ApprovalsViewModel approvals,
        ISessionStore session,
        ILiveRegionAnnouncer announcer)
    {
        Cabinets = cabinets;
        Machine = machine;
        Cabinet = cabinet;
        Audit = audit;
        Fleet = fleet;
        Approvals = approvals;

        _session = session;
        _announcer = announcer;

        // The task is kept rather than discarded. Selecting a row is a user
        // gesture with nothing to await it, so without this the load is
        // unobservable — and an exception escaping it would go unnoticed.
        Cabinets.SelectionChanged += (_, id) => PendingSelectionLoad = OnCabinetSelectedAsync(id);

        Machine.ActionSubmitted += (_, result) =>
        {
            // An action that needs approval has just joined the queue.
            // Refreshing the badge means the requester can see where it went
            // instead of having to hunt for it.
            if (result.Submitted && CanSeeApprovals)
            {
                PendingBadgeRefresh = RefreshApprovalBadgeAsync();
            }
        };

        foreach (ObservableViewModelBase screen in
                 new ObservableViewModelBase[] { Cabinets, Machine, Audit, Fleet, Approvals })
        {
            WatchForExpiry(screen);
        }
    }

    public CabinetListViewModel Cabinets { get; }

    /// <summary>
    /// The detail load started by the most recent cabinet selection, or a
    /// completed task. Await it to be sure the Machine tab has caught up with
    /// the selection; the view never needs to.
    /// </summary>
    public Task PendingSelectionLoad { get; private set; } = Task.CompletedTask;
    public MachineTabViewModel Machine { get; }
    public CabinetTabViewModel Cabinet { get; }
    public AuditTabViewModel Audit { get; }
    public FleetTabViewModel Fleet { get; }
    public ApprovalsViewModel Approvals { get; }

    /// <summary>
    /// Raised when the window needs a sign-in: at start-up, after a sign-out,
    /// and when a token expires mid-session. The window owns the login dialog;
    /// this ViewModel only says when one is needed.
    /// </summary>
    public event EventHandler<SignInReason>? SignInRequired;

    [ObservableProperty]
    private ShellView _currentView = ShellView.Cabinets;

    /// <summary>
    /// Index of the selected detail tab: 0 Machine, 1 Cabinet, 2 Audit, 3 Fleet.
    /// </summary>
    [ObservableProperty]
    private int _selectedTabIndex;

    public bool IsSignedIn => _session.IsSignedIn && !_session.MustChangePassword;

    public string SignedInAs => _session.DisplayName is { Length: > 0 } name
        ? $"{name} ({_session.Role})"
        : "Not signed in";

    public Role? Role => _session.Role;

    /// <summary>
    /// Whether the approvals queue is worth offering. Tier 1 cannot approve
    /// anything and the server refuses them the endpoint, so the entry point is
    /// hidden rather than offered and then refused.
    /// </summary>
    public bool CanSeeApprovals => _session.Role >= Contracts.Auth.Role.Tier2;

    /// <summary>Whether the audit tab is worth offering. Supervisor-only at the server.</summary>
    public bool CanSeeAudit => _session.Role >= Contracts.Auth.Role.Supervisor;

    /// <summary>
    /// The count on the approvals entry point, or null when there is nothing to
    /// show. Counts only what this user can actually act on — a badge that
    /// included their own requests would send them to a queue where every
    /// button is greyed out.
    /// </summary>
    public int? ApprovalBadge => Approvals.ActionableCount > 0 ? Approvals.ActionableCount : null;

    public string ApprovalBadgeAccessibleText => ApprovalBadge is { } count
        ? $"Approvals. {count} awaiting your decision."
        : "Approvals. Nothing awaiting your decision.";

    /// <summary>
    /// The shared live-region line. Screens write through
    /// <see cref="ILiveRegionAnnouncer"/>; the window renders this.
    /// </summary>
    [ObservableProperty]
    private string _announcement = string.Empty;

    /// <summary>
    /// Loads everything the window needs once a sign-in has succeeded. Called by
    /// the window after the login dialog closes.
    /// </summary>
    public async Task StartSessionAsync()
    {
        RaiseSessionChanged();

        CurrentView = ShellView.Cabinets;
        SelectedTabIndex = 0;

        await Cabinets.LoadAsync();

        // The fleet view is the thing a remote desktop session can never do, so
        // it is loaded up front rather than on first click.
        await Fleet.LoadAsync();

        if (CanSeeApprovals)
        {
            await Approvals.LoadAsync();
            OnPropertyChanged(nameof(ApprovalBadge));
        }

        _announcer.AnnounceImportant(
            $"Signed in as {SignedInAs}. {Cabinets.PageSummary}. " +
            (ApprovalBadge is { } badge
                ? $"{badge} actions await your approval."
                : "Nothing awaits your approval."));
    }

    [RelayCommand]
    private void ShowCabinets()
    {
        CurrentView = ShellView.Cabinets;
        _announcer.Announce($"Cabinets. {Cabinets.PageSummary}");
    }

    [RelayCommand]
    private async Task ShowApprovalsAsync()
    {
        CurrentView = ShellView.Approvals;
        await Approvals.LoadAsync();
        OnPropertyChanged(nameof(ApprovalBadge));
        _announcer.Announce($"Approval queue. {Approvals.QueueSummary}");
    }

    /// <summary>
    /// Shows the audit trail for the selected cabinet — the shortest path from
    /// "this cabinet is misbehaving" to "here is what has been done to it".
    /// </summary>
    [RelayCommand]
    private async Task ShowAuditForSelectedCabinetAsync()
    {
        if (Cabinets.SelectedCabinet is not { } row)
        {
            return;
        }

        SyncAuditCabinetOptions();

        CurrentView = ShellView.Cabinets;
        SelectedTabIndex = 2;

        await Audit.ShowForCabinetAsync(row.Id);
    }

    [RelayCommand]
    private async Task RefreshAllAsync()
    {
        await Cabinets.LoadAsync();
        await Fleet.LoadAsync();

        if (CanSeeApprovals)
        {
            await Approvals.LoadAsync();
            OnPropertyChanged(nameof(ApprovalBadge));
        }

        _announcer.Announce($"Refreshed. {Cabinets.PageSummary}. {Approvals.QueueSummary}");
    }

    /// <summary>Signs out and discards the token.</summary>
    [RelayCommand]
    private void SignOut() => EndSession(SignInReason.SignedOut);

    /// <summary>
    /// Cancels in-flight work on every screen. Called on sign-out and on window
    /// close, so a response arriving after the token was dropped cannot
    /// repopulate a view the user has left.
    /// </summary>
    public void DeactivateAll()
    {
        Cabinets.Deactivate();
        Machine.Deactivate();
        Audit.Deactivate();
        Fleet.Deactivate();
        Approvals.Deactivate();
    }

    private void EndSession(SignInReason reason)
    {
        DeactivateAll();

        _session.SignOut();

        Cabinets.Cabinets.Clear();
        Approvals.Queue.Clear();
        Audit.Entries.Clear();

        RaiseSessionChanged();

        _announcer.AnnounceImportant(reason == SignInReason.SignedOut
            ? "Signed out. The access token has been discarded."
            : "Your session expired and you were signed out.");

        SignInRequired?.Invoke(this, reason);
    }

    private async Task OnCabinetSelectedAsync(Guid? cabinetId)
    {
        if (cabinetId is not { } id)
        {
            return;
        }

        // The Machine tab loads per cabinet. The Audit tab is offered the same
        // cabinet as a filter option but is not reloaded: moving down the
        // cabinet list should not silently rerun a query the user built by hand.
        SyncAuditCabinetOptions();

        await Machine.LoadAsync(id);
    }

    private void SyncAuditCabinetOptions()
    {
        foreach (CabinetSummary summary in Cabinets.Cabinets.Select(c => c.Summary))
        {
            if (Audit.Cabinets.All(c => c.Id != summary.Id))
            {
                Audit.Cabinets.Add(summary);
            }
        }
    }

    /// <summary>
    /// The badge refresh started by the most recent action submission, or a
    /// completed task.
    /// </summary>
    public Task PendingBadgeRefresh { get; private set; } = Task.CompletedTask;

    private async Task RefreshApprovalBadgeAsync()
    {
        await Approvals.LoadAsync();
        OnPropertyChanged(nameof(ApprovalBadge));
        OnPropertyChanged(nameof(ApprovalBadgeAccessibleText));
    }

    /// <summary>Asks for a new sign-in when any screen reports an expired token.</summary>
    private void WatchForExpiry(ObservableViewModelBase viewModel) =>
        viewModel.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ObservableViewModelBase.RequiresReauthentication) &&
                viewModel.RequiresReauthentication &&
                _session.IsSignedIn)
            {
                EndSession(SignInReason.SessionExpired);
            }
        };

    private void RaiseSessionChanged()
    {
        OnPropertyChanged(nameof(IsSignedIn));
        OnPropertyChanged(nameof(SignedInAs));
        OnPropertyChanged(nameof(Role));
        OnPropertyChanged(nameof(CanSeeApprovals));
        OnPropertyChanged(nameof(CanSeeAudit));
        OnPropertyChanged(nameof(ApprovalBadge));
        OnPropertyChanged(nameof(ApprovalBadgeAccessibleText));
    }

    /// <summary>
    /// Records the shared live-region text. Called by the WPF announcer so the
    /// window has one place to render announcements from.
    /// </summary>
    public void SetAnnouncement(string message) => Announcement = message;
}
