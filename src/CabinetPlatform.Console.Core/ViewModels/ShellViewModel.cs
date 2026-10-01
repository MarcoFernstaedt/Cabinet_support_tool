using System.ComponentModel;
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
    /// <summary>The cabinet list and the detail tabs beside it.</summary>
    Cabinets,

    /// <summary>Search, the client hierarchy, and this rep's recent cabinets.</summary>
    Find,

    /// <summary>Actions waiting for a second person.</summary>
    Approvals,

    /// <summary>Supervisor enrollment decisions.</summary>
    Registrations,
    /// <summary>Supervisor staff accounts.</summary>
    Staff,
    Alerts
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
public sealed partial class ShellViewModel : ObservableObject, IDisposable
{
    private bool _disposed;
    private readonly ISessionStore _session;
    private readonly ILiveRegionAnnouncer _announcer;
    private readonly IApiClient _sessionApi;

    public ShellViewModel(
        CabinetListViewModel cabinets,
        CabinetFinderViewModel finder,
        MachineTabViewModel machine,
        CabinetTabViewModel cabinet,
        AuditTabViewModel audit,
        FleetTabViewModel fleet,
        ApprovalsViewModel approvals,
        RegistrationsViewModel registrations,
        ISessionStore session,
        ILiveRegionAnnouncer announcer,
        IApiClient sessionApi,
        StaffViewModel? staff = null,
        ConnectivityAlertsViewModel? alerts = null)
    {
        Cabinets = cabinets;
        Finder = finder;
        Machine = machine;
        Machine.PropertyChanged += OnMachinePropertyChanged;
        Cabinet = cabinet;
        Audit = audit;
        Fleet = fleet;
        Approvals = approvals;
        Registrations = registrations;
        Staff = staff;
        Alerts = alerts;
        if (Alerts is not null)
        {
            WatchForExpiry(Alerts);
            Alerts.CabinetChosen += (_, id) => PendingSelectionLoad = OpenCabinetAsync(id);
        }
        if (Staff is not null) WatchForExpiry(Staff);

        // The finder is reachable from every screen, so choosing a cabinet in
        // it has to land the same way as choosing one in the list: the detail
        // pane loads, and the shell goes back to showing it.

        Finder.SearchStarted += (_, _) => CurrentView = ShellView.Find;
        Finder.CabinetChosen += (_, id) => PendingSelectionLoad = OpenCabinetAsync(id);

        _session = session;
        _announcer = announcer;
        _sessionApi = sessionApi;

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
                 new ObservableViewModelBase[] { Cabinets, Finder, Machine, Audit, Fleet, Approvals, Registrations })
        {
            WatchForExpiry(screen);
        }
    }

    public CabinetListViewModel Cabinets { get; }

    /// <summary>
    /// Search, the client hierarchy, and this rep's recent cabinets.
    /// </summary>
    /// <remarks>
    /// Reachable from anywhere rather than being a screen a rep navigates to.
    /// With seven thousand cabinets, finding the right one is the most frequent
    /// thing anybody does here, and burying it behind a tab would mean a rep on
    /// a call losing whatever they were looking at to go and search.
    /// </remarks>
    public CabinetFinderViewModel Finder { get; }

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
    public RegistrationsViewModel Registrations { get; }
    public StaffViewModel? Staff { get; }
    public ConnectivityAlertsViewModel? Alerts { get; }
    public bool CanSeeAlerts => IsSignedIn && Alerts is not null;
    public bool CanSeeSiteAlerts => CanSeeAlerts && Machine.Path is { } path && path.SiteId != Guid.Empty;
    public bool CanSeeCabinetAlerts => CanSeeAlerts && Machine.Path is { } path && path.CabinetId != Guid.Empty;
    private void OnMachinePropertyChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(MachineTabViewModel.Path)) return;
        OnPropertyChanged(nameof(CanSeeSiteAlerts));
        OnPropertyChanged(nameof(CanSeeCabinetAlerts));
        ShowSiteAlertsCommand.NotifyCanExecuteChanged();
        ShowCabinetAlertsCommand.NotifyCanExecuteChanged();
    }
    [RelayCommand(CanExecute = nameof(CanSeeCabinetAlerts))]
    private async Task ShowCabinetAlertsAsync()
    {
        if (!CanSeeCabinetAlerts || Machine.Path is not { } path) return;
        CurrentView = ShellView.Alerts;
        await Alerts!.ShowCabinetAsync(path.CabinetId, path.CabinetName);
    }
    [RelayCommand(CanExecute = nameof(CanSeeSiteAlerts))]
    private async Task ShowSiteAlertsAsync()
    {
        if (!CanSeeSiteAlerts || Machine.Path is not { } path) return;
        CurrentView = ShellView.Alerts;
        await Alerts!.ShowSiteAsync(path.SiteId, $"{path.ClientName} / {path.SiteName}");
    }
    [RelayCommand(CanExecute = nameof(CanSeeAlerts))]
    private async Task ShowAlertsAsync()
    {
        if (!CanSeeAlerts) return;
        CurrentView = ShellView.Alerts;
        await Alerts!.ShowAllAsync();
    }
    public bool CanSeeStaff => CanSeeRegistrations && Staff is not null;

    [RelayCommand(CanExecute = nameof(CanSeeStaff))]
    private async Task ShowStaffAsync()
    {
        if (!CanSeeStaff) return;
        CurrentView = ShellView.Staff;
        await Staff!.LoadAsync();
    }
    public bool CanSeeRegistrations => IsSignedIn && _session.Role == Contracts.Auth.Role.Supervisor;

    /// <summary>
    /// Raised when the window needs a sign-in: at start-up, after a sign-out,
    /// and when a token expires mid-session. The window owns the login dialog;
    /// this ViewModel only says when one is needed.
    /// </summary>
    public event EventHandler<SignInReason>? SignInRequired;

    /// <summary>
    /// Whether this shell believes a session is running. Distinct from the
    /// session store's own flag, which the API client clears on its own when a
    /// refresh is refused.
    /// </summary>
    private bool _sessionLive;

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
    /// Whether the approvals queue is worth offering.
    /// </summary>
    /// <remarks>
    /// Every authenticated rep, because any rep may approve another's request —
    /// what they may not do is approve their own, and that is a per-request
    /// rule the queue itself applies rather than a reason to hide the queue.
    /// The property stays rather than being replaced with a literal so that
    /// tightening this later is a change here rather than in the markup.
    /// </remarks>
    public bool CanSeeApprovals => _session.IsSignedIn;

    /// <summary>
    /// Whether the audit tab is worth offering.
    /// </summary>
    /// <remarks>
    /// Every authenticated rep. With no case scoping and no per-rep cabinet
    /// assignment, the audit trail is the control that replaces them — and a
    /// control everybody can see is one everybody behaves as though exists.
    /// </remarks>
    public bool CanSeeAudit => _session.IsSignedIn;

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
        ObjectDisposedException.ThrowIf(_disposed, this);
        _sessionLive = true;

        RaiseSessionChanged();

        CurrentView = ShellView.Cabinets;
        SelectedTabIndex = 0;

        await Cabinets.LoadAsync();

        // The fleet view is the thing a remote desktop session can never do, so
        // it is loaded up front rather than on first click.
        if (_disposed) return;
        await Fleet.LoadAsync();

        // So the search box and the recent list are usable the moment the
        // window appears, rather than after a rep has clicked into them.
        if (_disposed) return;
        await Finder.LoadAsync();

        if (_disposed) return;
        if (CanSeeApprovals)
        {
            await Approvals.LoadAsync();
            OnPropertyChanged(nameof(ApprovalBadge));
        }

        if (_disposed) return;
        _announcer.AnnounceImportant(
            $"Signed in as {SignedInAs}. {Cabinets.PageSummary}. " +
            (ApprovalBadge is { } badge
                ? $"{badge} actions await your approval."
                : "Nothing awaits your approval."));
    }

    /// <summary>Checks account authority without fetching fleet data.</summary>
    public async Task CheckSessionAsync(CancellationToken ct)
    {
        if (_disposed || !_sessionLive) return;
        try
        {
            await _sessionApi.GetCurrentUserAsync(ct);
        }
        catch (ApiException ex) when (ex.RequiresReauthentication)
        {
            if (!_disposed && _sessionLive) EndSession(SignInReason.SessionExpired);
        }
        catch (ApiException)
        {
            // An outage is not proof of revoked authority. The next check retries.
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested || _disposed)
        {
        }
    }

    [RelayCommand]
    private void ShowCabinets()
    {
        CurrentView = ShellView.Cabinets;
        _announcer.Announce($"Cabinets. {Cabinets.PageSummary}");
    }

    /// <summary>
    /// Opens the finder and puts the caret in the search box.
    /// </summary>
    /// <remarks>
    /// Bound to an access key so it is reachable from the keyboard on any
    /// screen. A rep taking a second call while looking at the first client's
    /// cabinet should not have to navigate anywhere to start looking for the
    /// second one's.
    /// </remarks>
    [RelayCommand]
    private async Task ShowFinderAsync()
    {
        CurrentView = ShellView.Find;
        await Finder.LoadAsync();

        _announcer.Announce(
            "Find a cabinet. Search by client, site, department, cabinet name, serial number or " +
            $"cabinet id. {Finder.ResultSummary}");
    }

    /// <summary>
    /// Opens one cabinet in the detail pane, from wherever it was chosen.
    /// </summary>
    /// <param name="cabinetId">The cabinet.</param>
    public async Task OpenCabinetAsync(Guid cabinetId)
    {
        CurrentView = ShellView.Cabinets;
        SelectedTabIndex = 0;

        await Machine.LoadAsync(cabinetId);

        // The recent list has just gained this cabinet, server-side, because
        // reading a cabinet's detail is what puts it there.
        await Finder.LoadRecentAsync();

        _announcer.AnnounceImportant($"Opened {Machine.HeaderPath}.");
    }

    [RelayCommand(CanExecute = nameof(CanSeeRegistrations))]
    private async Task ShowRegistrationsAsync()
    {
        if (!CanSeeRegistrations) return;
        CurrentView = ShellView.Registrations;
        await Registrations.LoadAsync();
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
        // The loaded Machine header is the viewed identity. Finder can open a
        // cabinet outside the list's filters, leaving its row selection behind.
        // Path is cleared during loading, on failure and at sign-out, unlike
        // CabinetId which also holds an attempted (not yet loaded) selection.
        if (Machine.Path is not { } path)
        {
            return;
        }

        SyncAuditCabinetOptions();

        CurrentView = ShellView.Cabinets;
        SelectedTabIndex = 2;

        await Audit.ShowForCabinetAsync(path.CabinetId);
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

        if (CanSeeRegistrations && CurrentView == ShellView.Registrations) await Registrations.LoadAsync();
        if (CanSeeStaff && CurrentView == ShellView.Staff) await Staff!.LoadAsync();
        if (CanSeeAlerts && CurrentView == ShellView.Alerts) await Alerts!.LoadAsync();

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
        Finder.Deactivate();
        Machine.Deactivate();
        Audit.Deactivate();
        Fleet.Deactivate();
        Approvals.Deactivate();
        Registrations.Deactivate();
        Staff?.Deactivate();
        Alerts?.Deactivate();
    }

    private void EndSession(SignInReason reason)
    {
        if (_disposed) return;
        Dispose();
        _announcer.AnnounceImportant(reason == SignInReason.SignedOut
            ? "Signed out. The access token has been discarded."
            : "Your session expired and you were signed out.");
        SignInRequired?.Invoke(this, reason);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _sessionLive = false;
        Machine.PropertyChanged -= OnMachinePropertyChanged;

        DeactivateAll();

        _session.SignOut();

        Machine.Reset();
        Registrations.Reset();
        Staff?.Reset();
        Alerts?.Reset();
        Fleet.Summary = null;
        Fleet.Sites.Clear();
        Fleet.StaleCheckIns.Clear();
        Fleet.PendingUpdates.Clear();
        Fleet.DrivesNeedingAttention.Clear();
        Fleet.DiskHealthCounts.Clear();
        Fleet.CabinetHealthCounts.Clear();
        Fleet.ClientFilter = Fleet.SiteFilter = string.Empty;
        Fleet.CabinetsExamined = 0;
        Fleet.WorklistsTruncated = false;
        Audit.SelectedCabinet = null;
        Audit.ActionFilter = null;
        Audit.Page = 1;
        Audit.TotalCount = Audit.TotalPages = 0;
        Audit.Cabinets.Clear();
        Approvals.SelectedRequest = null;
        Cabinets.SearchText = string.Empty;
        Cabinets.ClientFilter = Cabinets.SiteFilter = null;
        Cabinets.HealthFilter = null;
        Cabinets.ActiveFilter = true;
        Cabinets.Page = 1;
        Cabinets.TotalCount = Cabinets.TotalPages = 0;
        Finder.ClearSearch();
        Finder.SelectedClient = null;
        Cabinets.SelectedCabinet = null;
        Cabinets.Cabinets.Clear();
        Approvals.Queue.Clear();
        Audit.Entries.Clear();

        // The recent list is this rep's, so it goes with their session rather
        // than being left on screen for whoever signs in next.
        Finder.Results.Clear();
        Finder.Recent.Clear();
        Finder.Clients.Clear();
        Finder.HierarchySites.Clear();

        RaiseSessionChanged();
    }

    private async Task OnCabinetSelectedAsync(Guid? cabinetId)
    {
        if (cabinetId is not { } id)
        {
            Machine.Reset();
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
    /// <remarks>
    /// Gated on this shell's own view of the session rather than on
    /// <c>_session.IsSignedIn</c>. The API client clears the session itself when
    /// a refresh is refused, so by the time a screen reports the expiry the
    /// store already says "signed out" — and reading that as "somebody has
    /// already handled this" left the user looking at a dead window with no
    /// login prompt. The flag makes the check "have I already ended this
    /// session?", which is the question actually being asked.
    /// </remarks>
    private void WatchForExpiry(ObservableViewModelBase viewModel) =>
        viewModel.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ObservableViewModelBase.RequiresReauthentication) &&
                viewModel.RequiresReauthentication &&
                _sessionLive)
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
        OnPropertyChanged(nameof(CanSeeRegistrations));
        ShowRegistrationsCommand.NotifyCanExecuteChanged();
        OnPropertyChanged(nameof(CanSeeStaff));
        ShowStaffCommand.NotifyCanExecuteChanged();
        OnPropertyChanged(nameof(CanSeeAlerts));
        ShowAlertsCommand.NotifyCanExecuteChanged();
        OnPropertyChanged(nameof(CanSeeSiteAlerts));
        ShowSiteAlertsCommand.NotifyCanExecuteChanged();
        OnPropertyChanged(nameof(CanSeeCabinetAlerts));
        ShowCabinetAlertsCommand.NotifyCanExecuteChanged();
        OnPropertyChanged(nameof(ApprovalBadge));
        OnPropertyChanged(nameof(ApprovalBadgeAccessibleText));
    }

    /// <summary>
    /// Records the shared live-region text. Called by the WPF announcer so the
    /// window has one place to render announcements from.
    /// </summary>
    public void SetAnnouncement(string message) => Announcement = message;
}
