using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Mashura.CabinetSupport.Console.Core.Api;
using Mashura.CabinetSupport.Console.Core.Presentation;
using Mashura.CabinetSupport.Contracts.Cabinets;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Console.Core.ViewModels;

/// <summary>Which top-level view the shell is showing.</summary>
public enum ShellView
{
    SignIn,
    Cabinets,
    Approvals
}

/// <summary>
/// The main window: sign-in state, the cabinet list, the detail tabs, and the
/// approvals queue.
/// </summary>
/// <remarks>
/// Also the one place that reacts to an expired token. Every screen reports
/// <see cref="ObservableViewModelBase.RequiresReauthentication"/> the same way,
/// and the shell watches for it and returns to sign-in — rather than each screen
/// deciding for itself and one of them forgetting.
/// </remarks>
public sealed partial class ShellViewModel : ObservableObject
{
    private readonly ISessionStore _session;
    private readonly ILiveRegionAnnouncer _announcer;

    public ShellViewModel(
        LoginViewModel login,
        CabinetListViewModel cabinets,
        MachineTabViewModel machine,
        CabinetTabViewModel cabinet,
        AuditTabViewModel audit,
        FleetTabViewModel fleet,
        ApprovalsViewModel approvals,
        ISessionStore session,
        ILiveRegionAnnouncer announcer)
    {
        Login = login;
        Cabinets = cabinets;
        Machine = machine;
        Cabinet = cabinet;
        Audit = audit;
        Fleet = fleet;
        Approvals = approvals;

        _session = session;
        _announcer = announcer;

        Login.SignedIn += async (_, _) => await OnSignedInAsync();
        Cabinets.SelectionChanged += async (_, id) => await OnCabinetSelectedAsync(id);
        Machine.ActionSubmitted += async (_, result) =>
        {
            // An action that needs approval has just joined the queue. Refreshing
            // the badge means the requester can see where it went without
            // hunting for it.
            if (result.Submitted)
            {
                await Approvals.LoadAsync();
                OnPropertyChanged(nameof(ApprovalBadge));
            }
        };

        WatchForExpiry(Cabinets);
        WatchForExpiry(Machine);
        WatchForExpiry(Audit);
        WatchForExpiry(Fleet);
        WatchForExpiry(Approvals);
    }

    public LoginViewModel Login { get; }
    public CabinetListViewModel Cabinets { get; }
    public MachineTabViewModel Machine { get; }
    public CabinetTabViewModel Cabinet { get; }
    public AuditTabViewModel Audit { get; }
    public FleetTabViewModel Fleet { get; }
    public ApprovalsViewModel Approvals { get; }

    [ObservableProperty]
    private ShellView _currentView = ShellView.SignIn;

    /// <summary>
    /// Index of the selected detail tab: 0 Machine, 1 Cabinet, 2 Audit, 3 Fleet.
    /// </summary>
    [ObservableProperty]
    private int _selectedTabIndex;

    public bool IsSignedIn => _session.IsSignedIn && !_session.MustChangePassword;

    public string SignedInAs => _session.DisplayName is { Length: > 0 } name
        ? $"{name} ({_session.Role})"
        : string.Empty;

    public UserRole? Role => _session.Role;

    /// <summary>
    /// Whether the approvals queue is worth offering. Tier 1 cannot approve
    /// anything, and the server refuses them the endpoint, so the entry point is
    /// hidden rather than offered and then refused.
    /// </summary>
    public bool CanSeeApprovals => _session.Role >= UserRole.Tier2;

    /// <summary>Whether the audit tab is worth offering. Supervisor-only at the server.</summary>
    public bool CanSeeAudit => _session.Role >= UserRole.Supervisor;

    /// <summary>
    /// The count on the approvals entry point, or null when there is nothing to
    /// show. Counts only what this user can actually act on.
    /// </summary>
    public int? ApprovalBadge => Approvals.ActionableCount > 0 ? Approvals.ActionableCount : null;

    /// <summary>
    /// A single live-region line the whole window shares. Screens write through
    /// <see cref="ILiveRegionAnnouncer"/>; the WPF layer renders this.
    /// </summary>
    [ObservableProperty]
    private string _announcement = string.Empty;

    [RelayCommand]
    private async Task ShowCabinetsAsync()
    {
        CurrentView = ShellView.Cabinets;
        _announcer.Announce("Cabinets.");

        if (Cabinets.Cabinets.Count == 0)
        {
            await Cabinets.LoadAsync();
        }
    }

    [RelayCommand]
    private async Task ShowApprovalsAsync()
    {
        CurrentView = ShellView.Approvals;
        _announcer.Announce("Approval queue.");
        await Approvals.LoadAsync();
        OnPropertyChanged(nameof(ApprovalBadge));
    }

    /// <summary>
    /// Signs out and clears the token. Also called on window close, so a console
    /// left open overnight does not still hold a usable token in memory when
    /// someone closes it in the morning.
    /// </summary>
    [RelayCommand]
    private void SignOut()
    {
        DeactivateAll();

        _session.SignOut();
        Login.Reset();

        CurrentView = ShellView.SignIn;

        RaiseSessionChanged();
        _announcer.AnnounceImportant("Signed out. The access token has been discarded.");
    }

    /// <summary>
    /// Cancels in-flight work on every screen. Called on sign-out and on exit, so
    /// a response arriving after the token was dropped cannot repopulate a view
    /// the user has left.
    /// </summary>
    public void DeactivateAll()
    {
        Cabinets.Deactivate();
        Machine.Deactivate();
        Audit.Deactivate();
        Fleet.Deactivate();
        Approvals.Deactivate();
    }

    private async Task OnSignedInAsync()
    {
        RaiseSessionChanged();

        CurrentView = ShellView.Cabinets;

        await Cabinets.LoadAsync();

        // The fleet view is the one that justifies this tool existing, so it is
        // loaded up front rather than on first click.
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

    private async Task OnCabinetSelectedAsync(Guid? cabinetId)
    {
        if (cabinetId is not { } id)
        {
            return;
        }

        // The Machine tab is the one that loads per cabinet. The Audit tab is
        // given the same cabinet as a filter option but not reloaded, because
        // moving down the cabinet list should not silently rerun a query the
        // user built by hand.
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
    /// Shows the audit trail for the cabinet currently selected, which is the
    /// shortest path from "this cabinet is misbehaving" to "here is what has been
    /// done to it".
    /// </summary>
    [RelayCommand]
    private async Task ShowAuditForSelectedCabinetAsync()
    {
        if (Cabinets.SelectedCabinet is not { } row)
        {
            return;
        }

        SyncAuditCabinetOptions();
        SelectedTabIndex = 2;
        await Audit.ShowForCabinetAsync(row.Id);
    }

    /// <summary>
    /// Sends the user back to sign-in when any screen reports an expired token.
    /// </summary>
    private void WatchForExpiry(ObservableViewModelBase viewModel) =>
        viewModel.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName != nameof(ObservableViewModelBase.RequiresReauthentication) ||
                !viewModel.RequiresReauthentication ||
                CurrentView == ShellView.SignIn)
            {
                return;
            }

            DeactivateAll();
            _session.SignOut();
            Login.Reset();
            Login.ErrorMessageForExpiredSession();

            CurrentView = ShellView.SignIn;
            RaiseSessionChanged();
        };

    private void RaiseSessionChanged()
    {
        OnPropertyChanged(nameof(IsSignedIn));
        OnPropertyChanged(nameof(SignedInAs));
        OnPropertyChanged(nameof(Role));
        OnPropertyChanged(nameof(CanSeeApprovals));
        OnPropertyChanged(nameof(CanSeeAudit));
        OnPropertyChanged(nameof(ApprovalBadge));
    }

    /// <summary>
    /// Records the shared live-region text. Called by the WPF announcer so the
    /// window has one place to render announcements from.
    /// </summary>
    public void SetAnnouncement(string message) => Announcement = message;
}
