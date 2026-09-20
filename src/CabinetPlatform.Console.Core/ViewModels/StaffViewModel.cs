using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>Supervisor staff administration using the existing user API.</summary>
public sealed partial class StaffViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly ISessionStore _session;
    public StaffViewModel(IApiClient api, ISessionStore session, ILiveRegionAnnouncer announcer) : base(announcer)
    { _api = api; _session = session; }

    public ObservableCollection<UserDto> Users { get; } = new();
    public IReadOnlyList<Role> SupportTiers { get; } = new[] { Role.Tier1, Role.Tier2 };
    public bool IsSupervisor => _session.IsSignedIn && !_session.MustChangePassword && _session.Role == Role.Supervisor;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(CreateCommand))] private string _username = string.Empty;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(CreateCommand))] private string _displayName = string.Empty;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(CreateCommand))] private Role _selectedTier = Role.Tier1;
    [ObservableProperty] private string _outcome = string.Empty;
    [ObservableProperty] private UserDto? _selectedUser;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(DisableCommand))] private bool _disableConfirmed;
    [ObservableProperty] private int _page = 1;
    [ObservableProperty] private int _totalCount;
    [ObservableProperty] private bool _hasMore;
    public string PageSummary => $"{TotalCount} staff accounts. Page {Page}.";
    private bool CanLoad() => IsSupervisor && !IsLoading;
    private bool CanCreate(string? password) => CanLoad() && SupportTiers.Contains(SelectedTier) &&
        !string.IsNullOrWhiteSpace(Username) && Username.Length <= 128 &&
        !string.IsNullOrWhiteSpace(DisplayName) && DisplayName.Length <= 128 && !string.IsNullOrEmpty(password);

    public async Task LoadAsync()
    {
        if (!CanLoad()) return;
        Users.Clear(); SelectedUser = null;
        await RunAsync(async ct =>
        {
            var page = await _api.GetUsersAsync(new PagedQuery { Page = Page, PageSize = 50 }, ct);
            ct.ThrowIfCancellationRequested();
            foreach (var user in page.Items) Users.Add(user);
            TotalCount = page.TotalCount; HasMore = page.HasMore;
            OnPropertyChanged(nameof(PageSummary));
        });
    }

    [RelayCommand(CanExecute = nameof(CanCreate))]
    private async Task CreateAsync(string? password)
    {
        if (!CanCreate(password)) return;
        var request = new CreateUserRequest { Username = Username.Trim(), DisplayName = DisplayName.Trim(),
            Role = SelectedTier, InitialPassword = password! };
        var result = await RunAsync(ct => _api.CreateUserAsync(request, ct));
        Outcome = result is null ? "Creation not confirmed. Refresh the staff list before retrying; the account may already exist."
            : $"Created {result.Username} ({result.Role}). The user must change the temporary password at sign-in.";
        if (result is null) return;
        Username = DisplayName = string.Empty;
        await LoadAsync();
    }

    [RelayCommand(CanExecute = nameof(CanLoad))]
    private async Task RefreshAsync() { Page = 1; await LoadAsync(); }
    private bool CanEdit() => CanLoad() && SelectedUser is { IsActive: true } user &&
        user.Id != _session.UserId && SupportTiers.Contains(user.Role);
    private bool CanSaveTier() => CanEdit() && SupportTiers.Contains(SelectedTier);
    private bool CanDisable() => CanEdit() && DisableConfirmed;

    [RelayCommand(CanExecute = nameof(CanSaveTier))]
    private async Task SaveTierAsync()
    {
        if (!CanSaveTier()) return;
        await UpdateAsync(new UpdateUserRequest { Role = SelectedTier });
    }

    [RelayCommand(CanExecute = nameof(CanDisable))]
    private async Task DisableAsync()
    {
        if (!CanDisable()) return;
        await UpdateAsync(new UpdateUserRequest { IsActive = false });
    }

    private async Task UpdateAsync(UpdateUserRequest request)
    {
        var selected = SelectedUser!;
        UserDto? result = null;
        try { result = await RunAsync(ct => _api.UpdateUserAsync(selected.Id, request, ct)); }
        finally { SelectedUser = null; DisableConfirmed = false; }
        Outcome = result is null ? "Change not confirmed. Refresh staff before trying again; the server may have saved it."
            : $"Updated {result.Username}: {result.Role}, {(result.IsActive ? "active" : "disabled")}.";
        if (result is null) { Users.Clear(); return; }
        await LoadAsync();
    }

    partial void OnSelectedUserChanged(UserDto? value)
    {
        DisableConfirmed = false;
        if (value is not null && SupportTiers.Contains(value.Role)) SelectedTier = value.Role;
        NotifyCommands();
    }
    partial void OnSelectedTierChanged(Role value) => NotifyCommands();
    private bool CanNext() => CanLoad() && HasMore;
    private bool CanPrevious() => CanLoad() && Page > 1;
    [RelayCommand(CanExecute = nameof(CanNext))]
    private async Task NextAsync() { Page++; await LoadAsync(); }
    [RelayCommand(CanExecute = nameof(CanPrevious))]
    private async Task PreviousAsync() { Page--; await LoadAsync(); }

    public void Reset()
    {
        Deactivate(); Users.Clear(); SelectedUser = null;
        Username = DisplayName = Outcome = string.Empty;
        Page = 1; TotalCount = 0; HasMore = false; SelectedTier = Role.Tier1;
        ClearError(); OnPropertyChanged(nameof(PageSummary)); NotifyCommands();
    }
    protected override void OnLoadingChanged(bool isLoading) => NotifyCommands();
    private void NotifyCommands()
    {
        CreateCommand.NotifyCanExecuteChanged(); RefreshCommand.NotifyCanExecuteChanged();
        SaveTierCommand.NotifyCanExecuteChanged(); DisableCommand.NotifyCanExecuteChanged();
        NextCommand.NotifyCanExecuteChanged(); PreviousCommand.NotifyCanExecuteChanged();
    }
}
