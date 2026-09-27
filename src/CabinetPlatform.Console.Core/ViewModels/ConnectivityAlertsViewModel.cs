using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Telemetry;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>Historical incident workflow annotations, never a current health claim.</summary>
public sealed partial class ConnectivityAlertsViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly ISessionStore _session;
    private int _generation;
    public ConnectivityAlertsViewModel(IApiClient api, ISessionStore session, ILiveRegionAnnouncer announcer) : base(announcer)
    { _api = api; _session = session; }

    public ObservableCollection<ConnectivityAlertDto> Alerts { get; } = new();
    public event EventHandler<Guid>? SourceChosen;
    private bool CanOpen() => CanLoad() && SelectedAlert is { } row && Alerts.Contains(row);
    [RelayCommand(CanExecute = nameof(CanOpen))]
    private void OpenSource()
    {
        if (CanOpen()) SourceChosen?.Invoke(this, SelectedAlert!.SourceCabinetId);
    }
    [ObservableProperty] private ConnectivityAlertDto? _selectedAlert;
    [ObservableProperty] private string _note = string.Empty;
    [ObservableProperty] private bool _includeResolved;
    [ObservableProperty] private string _outcome = string.Empty;
    [ObservableProperty] private int _page = 1;
    [ObservableProperty] private int _totalCount;
    [ObservableProperty] private bool _hasMore;
    public string PageSummary => $"{TotalCount} retained incidents. Page {Page}. Historical queue snapshot; refresh to recheck.";
    private bool CanNext() => CanLoad() && HasMore;
    private bool CanPrevious() => CanLoad() && Page > 1;
    [RelayCommand(CanExecute = nameof(CanNext))]
    private async Task NextAsync() { if (!CanNext()) return; Page++; await LoadAsync(); }
    [RelayCommand(CanExecute = nameof(CanPrevious))]
    private async Task PreviousAsync() { if (!CanPrevious()) return; Page--; await LoadAsync(); }
    private bool CanLoad() => _session.IsSignedIn && !_session.MustChangePassword && !IsLoading;
    private bool CanAnnotate(string status) => CanLoad() && SelectedAlert is { } row && Alerts.Contains(row) &&
        row.Status == status && !string.IsNullOrWhiteSpace(Note) && Note.Length <= 1000;
    private bool CanAcknowledge() => CanAnnotate("Open");
    private bool CanResolve() => CanAnnotate("Acknowledged");

    public async Task LoadAsync()
    {
        if (!CanLoad()) return;
        Alerts.Clear(); SelectedAlert = null;
        await RunAsync(async ct =>
        {
            var page = await _api.GetConnectivityAlertsAsync(new ConnectivityAlertQuery { IncludeResolved = IncludeResolved, Page = Page, PageSize = 50 }, ct);
            ct.ThrowIfCancellationRequested();
            foreach (var row in page.Items) Alerts.Add(row);
            TotalCount = page.TotalCount; HasMore = page.HasMore;
            OnPropertyChanged(nameof(PageSummary));
        });
    }
    [RelayCommand(CanExecute = nameof(CanLoad))]
    private async Task RefreshAsync() { Page = 1; await LoadAsync(); }
    [RelayCommand(CanExecute = nameof(CanAcknowledge))]
    private Task AcknowledgeAsync() => AnnotateAsync(false);
    [RelayCommand(CanExecute = nameof(CanResolve))]
    private Task ResolveAsync() => AnnotateAsync(true);
    private async Task AnnotateAsync(bool resolve)
    {
        if (!(resolve ? CanResolve() : CanAcknowledge())) return;
        var row = SelectedAlert!;
        int generation = _generation;
        var request = new AnnotateConnectivityAlertRequest { SourceCabinetId = row.SourceCabinetId, Note = Note.Trim() };
        bool success = await RunAsync(ct => resolve
            ? _api.ResolveConnectivityAlertAsync(row.Id, request, ct)
            : _api.AcknowledgeConnectivityAlertAsync(row.Id, request, ct));
        if (generation != _generation || !_session.IsSignedIn) return;
        SelectedAlert = null; Note = string.Empty;
        Outcome = success ? "Annotation saved. Measured reachability was not changed." : "Change not confirmed. Refresh before retrying; the server may have saved it.";
        if (success) await LoadAsync();
        else Alerts.Clear();
    }
    partial void OnSelectedAlertChanged(ConnectivityAlertDto? value) { Note = string.Empty; NotifyCommands(); }
    partial void OnNoteChanged(string value) => NotifyCommands();
    protected override void OnLoadingChanged(bool isLoading) => NotifyCommands();
    private void NotifyCommands()
    {
        RefreshCommand.NotifyCanExecuteChanged(); AcknowledgeCommand.NotifyCanExecuteChanged(); ResolveCommand.NotifyCanExecuteChanged();
        OpenSourceCommand.NotifyCanExecuteChanged();
        NextCommand.NotifyCanExecuteChanged(); PreviousCommand.NotifyCanExecuteChanged();
    }
    public void Reset()
    {
        Deactivate(); Alerts.Clear(); SelectedAlert = null; Note = Outcome = string.Empty; IncludeResolved = false; ClearError(); NotifyCommands();
        Page = 1; TotalCount = 0; HasMore = false; OnPropertyChanged(nameof(PageSummary));
    }
    public override void Deactivate()
    {
        ++_generation;
        base.Deactivate();
    }
}
