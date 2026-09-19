using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.Sections;

public sealed partial class EventLogSectionViewModel
{
    private IApiClient? _viewApi;
    private ISessionStore? _viewSession;
    private long _viewGeneration;

    [ObservableProperty] private EventChannelInfo? _selectedChannel;
    [ObservableProperty, NotifyCanExecuteChangedFor(nameof(SaveChannelViewCommand))]
    private string _newChannelName = string.Empty;
    [ObservableProperty, NotifyCanExecuteChangedFor(nameof(SaveChannelViewCommand))]
    private string _newViewName = string.Empty;
    [ObservableProperty, NotifyCanExecuteChangedFor(nameof(SaveChannelViewCommand))]
    private string _newViewReason = string.Empty;
    [ObservableProperty, NotifyCanExecuteChangedFor(nameof(SaveChannelViewCommand))]
    private EventLogLevel _newMinimumLevel = EventLogLevel.Verbose;
    [ObservableProperty, NotifyCanExecuteChangedFor(nameof(SaveChannelViewCommand))]
    private string _newProviderName = string.Empty;
    [ObservableProperty, NotifyCanExecuteChangedFor(nameof(SaveChannelViewCommand))]
    private string _newEventId = string.Empty;
    public IReadOnlyList<EventLogLevel> LevelChoices { get; } = new[]
    {
        EventLogLevel.Critical, EventLogLevel.Error, EventLogLevel.Warning,
        EventLogLevel.Information, EventLogLevel.Verbose
    };
    [ObservableProperty] private string _viewCreationStatus = string.Empty;

    /// <summary>Presentation only. The create endpoint independently authorizes the current user.</summary>
    public bool CanDefineViews => _viewSession is { IsSignedIn: true, Role: Role.Supervisor, MustChangePassword: false };

    public void ConfigureViewCreation(IApiClient api, ISessionStore session)
    {
        if (_viewSession is not null) _viewSession.Changed -= OnViewSessionChanged;
        _viewApi = api;
        _viewSession = session;
        _viewSession.Changed += OnViewSessionChanged;
        OnPropertyChanged(nameof(CanDefineViews));
        SaveChannelViewCommand.NotifyCanExecuteChanged();
    }

    private void OnViewSessionChanged(object? sender, EventArgs e)
    {
        ResetChannelDraft();
        OnPropertyChanged(nameof(CanDefineViews));
        SaveChannelViewCommand.NotifyCanExecuteChanged();
    }

    partial void OnSelectedChannelChanged(EventChannelInfo? value)
    {
        if (value is not null) NewChannelName = value.Name;
    }

    private bool CanSaveChannelView() => CanDefineViews && _viewApi is not null && EventChannelName.IsValid(NewChannelName)
        && !string.IsNullOrWhiteSpace(NewViewName) && NewViewName.Trim().Length <= 128
        && !string.IsNullOrWhiteSpace(NewViewReason) && NewViewReason.Length <= 2000
        && LevelChoices.Contains(NewMinimumLevel) && NewProviderName.Length <= 256
        && (string.IsNullOrEmpty(NewEventId) || int.TryParse(NewEventId, System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture, out int id) && id is >= 0 and <= 65535);

    [RelayCommand(CanExecute = nameof(CanSaveChannelView))]
    private async Task SaveChannelViewAsync(CancellationToken token)
    {
        if (!CanSaveChannelView()) return;
        long generation = _viewGeneration;
        var request = new CreateEventLogViewRequest
        {
            DisplayName = NewViewName, ChannelNames = new[] { NewChannelName },
            LogNames = Array.Empty<EventLogName>(),
            Sources = string.IsNullOrWhiteSpace(NewProviderName) ? Array.Empty<string>() : new[] { NewProviderName },
            EventIds = string.IsNullOrEmpty(NewEventId) ? Array.Empty<int>() : new[] { int.Parse(NewEventId, System.Globalization.CultureInfo.InvariantCulture) },
            MinimumLevel = NewMinimumLevel, DefaultWindowHours = 24, MaximumEntries = 500,
            Description = "Filtered native channel records. Read access is checked at execution; omitted provider or event ID means any.",
            Reason = NewViewReason
        };
        ViewCreationStatus = "Saving shared view; no cabinet read has been requested yet.";
        try
        {
            var saved = await _viewApi!.CreateEventLogViewAsync(request, token);
            if (generation != _viewGeneration) return;
            Views.Add(saved);
            SelectedView = saved;
            ViewCreationStatus = "Shared view saved and selected. Choose a window, then Run event log view to request records.";
        }
        catch (ApiException e)
        {
            if (generation == _viewGeneration) ViewCreationStatus = "View not saved: " + e.Message;
        }
        catch (OperationCanceledException)
        {
            if (generation == _viewGeneration) ViewCreationStatus = "Save cancelled; refresh views before retrying because the server may have accepted it.";
        }
        catch (Exception)
        {
            if (generation == _viewGeneration) ViewCreationStatus = "Save outcome unavailable. Refresh views before retrying; no cabinet read was requested.";
        }
    }

    private void ResetChannelDraft()
    {
        _viewGeneration++;
        SelectedChannel = null;
        NewChannelName = string.Empty;
        NewViewName = string.Empty;
        NewViewReason = string.Empty;
        NewMinimumLevel = EventLogLevel.Verbose;
        NewProviderName = NewEventId = string.Empty;
        ViewCreationStatus = string.Empty;
    }
}
