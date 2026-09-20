using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Registrations;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>Supervisor decisions on identity-only enrollment requests.</summary>
public sealed partial class RegistrationsViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly ISessionStore _session;
    public RegistrationsViewModel(IApiClient api, ISessionStore session, ILiveRegionAnnouncer announcer)
        : base(announcer) { _api = api; _session = session; }

    public ObservableCollection<PendingRegistrationDto> Queue { get; } = new();
    public IReadOnlyList<CabinetRole> Roles { get; } = new[] { CabinetRole.Unknown, CabinetRole.Sync, CabinetRole.Satellite, CabinetRole.Standalone };
    public IReadOnlyList<RegistrationStatus> Statuses { get; } = new[] { RegistrationStatus.Pending, RegistrationStatus.Rejected, RegistrationStatus.Approved };
    public bool IsSupervisor => _session.IsSignedIn && !_session.MustChangePassword && _session.Role == Role.Supervisor;

    [ObservableProperty] private PendingRegistrationDto? _selectedRegistration;
    [ObservableProperty] private string _clientName = string.Empty;
    [ObservableProperty] private string _friendlyName = string.Empty;
    [ObservableProperty] private string _siteName = string.Empty;
    [ObservableProperty] private string _departmentName = string.Empty;
    [ObservableProperty] private CabinetRole _cabinetRole = CabinetRole.Unknown;
    [ObservableProperty] private string _reason = string.Empty;
    [ObservableProperty] private string _ticketReference = string.Empty;
    [ObservableProperty] private bool _identityConfirmed;
    [ObservableProperty] private RegistrationStatus _statusFilter = RegistrationStatus.Pending;
    [ObservableProperty] private int _page = 1;
    [ObservableProperty] private int _totalCount;
    [ObservableProperty] private bool _hasMore;
    [ObservableProperty] private string _outcome = string.Empty;
    public string PageSummary => $"{StatusFilter}: {TotalCount} registration(s). Page {Page}.";

    private bool CanLoad() => IsSupervisor && !IsLoading;
    private bool CanDecide() => CanLoad() && IdentityConfirmed && SelectedRegistration?.Status == RegistrationStatus.Pending;
    private bool CanAccept() => CanDecide() && !string.IsNullOrWhiteSpace(ClientName) &&
        !string.IsNullOrWhiteSpace(SiteName) && CabinetRole is CabinetRole.Sync or CabinetRole.Satellite or CabinetRole.Standalone;
    private bool CanReject() => CanDecide() && !string.IsNullOrWhiteSpace(Reason);
    private bool CanNext() => CanLoad() && HasMore;
    private bool CanPrevious() => CanLoad() && Page > 1;

    public async Task LoadAsync()
    {
        if (!CanLoad()) return;
        SelectedRegistration = null;
        Queue.Clear();
        await RunAsync(async ct =>
        {
            var result = await _api.GetRegistrationsAsync(new RegistrationQuery { Status = StatusFilter, Page = Page, PageSize = 50 }, ct);
            ct.ThrowIfCancellationRequested();
            foreach (var row in result.Items) Queue.Add(row);
            TotalCount = result.TotalCount;
            HasMore = result.HasMore;
            OnPropertyChanged(nameof(PageSummary));
            Announcer.Announce(PageSummary);
        });
    }

    [RelayCommand(CanExecute = nameof(CanLoad))]
    private async Task RefreshAsync() { Page = 1; await LoadAsync(); }
    [RelayCommand(CanExecute = nameof(CanNext))]
    private async Task NextAsync() { Page++; await LoadAsync(); }
    [RelayCommand(CanExecute = nameof(CanPrevious))]
    private async Task PreviousAsync() { Page--; await LoadAsync(); }

    [RelayCommand(CanExecute = nameof(CanAccept))]
    private async Task AcceptAsync()
    {
        if (!CanAccept()) return;
        var selected = SelectedRegistration!;
        var request = new ApproveRegistrationRequest
        {
            ClientName = ClientName.Trim(), SiteName = SiteName.Trim(), Role = CabinetRole,
            FriendlyName = FriendlyName.Trim(),
            DepartmentName = DepartmentName.Trim(), TicketReference = TicketReference.Trim()
        };
        await DecideAsync(selected, true, ct => _api.ApproveRegistrationAsync(selected.Id, request, ct));
    }

    [RelayCommand(CanExecute = nameof(CanReject))]
    private async Task RejectAsync()
    {
        if (!CanReject()) return;
        var selected = SelectedRegistration!;
        var request = new RejectRegistrationRequest { Reason = Reason.Trim(), TicketReference = TicketReference.Trim() };
        await DecideAsync(selected, false, ct => _api.RejectRegistrationAsync(selected.Id, request, ct));
    }

    private async Task DecideAsync(PendingRegistrationDto selected, bool accepted, Func<CancellationToken, Task> decide)
    {
        Outcome = string.Empty;
        bool success = false;
        try
        {
            success = await RunAsync(decide);
        }
        finally
        {
            IdentityConfirmed = false;
            if (!success)
            {
                // A lost response is not proof that a write failed. Quarantine
                // even if an unexpected exception propagates; never replay it.
                SelectedRegistration = null;
                Queue.Clear();
                Outcome = "Decision not confirmed. Refresh the queue before trying again; the server may already have recorded it.";
            }
        }
        if (!success) return;
        Outcome = accepted
            ? $"Accepted {selected.Hostname} ({selected.MachineId}). The agent learns its cabinet identity on its next retry."
            : $"Rejected {selected.Hostname} ({selected.MachineId}). Retries remain rejected; this screen does not undo rejection.";
        Announcer.AnnounceImportant(Outcome);
        await LoadAsync();
    }

    public void Reset()
    {
        Deactivate();
        Queue.Clear();
        SelectedRegistration = null;
        FriendlyName = ClientName = SiteName = DepartmentName = Reason = TicketReference = Outcome = string.Empty;
        CabinetRole = CabinetRole.Unknown;
        StatusFilter = RegistrationStatus.Pending;
        Page = 1;
        TotalCount = 0;
        HasMore = false;
        ClearError();
        OnPropertyChanged(nameof(PageSummary));
        NotifyCommands();
    }

    partial void OnSelectedRegistrationChanged(PendingRegistrationDto? value)
    {
        IdentityConfirmed = false;
        FriendlyName = ClientName = SiteName = DepartmentName = Reason = TicketReference = string.Empty;
        CabinetRole = CabinetRole.Unknown;
        NotifyCommands();
    }
    partial void OnClientNameChanged(string value) => NotifyCommands();
    partial void OnSiteNameChanged(string value) => NotifyCommands();
    partial void OnCabinetRoleChanged(CabinetRole value) => NotifyCommands();
    partial void OnReasonChanged(string value) => NotifyCommands();
    partial void OnIdentityConfirmedChanged(bool value) => NotifyCommands();
    partial void OnStatusFilterChanged(RegistrationStatus value)
    {
        Deactivate();
        Page = 1;
        SelectedRegistration = null;
        Queue.Clear();
        TotalCount = 0;
        HasMore = false;
        Outcome = string.Empty;
        OnPropertyChanged(nameof(PageSummary));
        NotifyCommands();
    }
    protected override void OnLoadingChanged(bool isLoading) => NotifyCommands();
    private void NotifyCommands()
    {
        AcceptCommand.NotifyCanExecuteChanged();
        RejectCommand.NotifyCanExecuteChanged();
        RefreshCommand.NotifyCanExecuteChanged();
        NextCommand.NotifyCanExecuteChanged();
        PreviousCommand.NotifyCanExecuteChanged();
    }
}
