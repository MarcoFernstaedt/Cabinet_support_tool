using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// The Machine tab: one collapsible section per payload category, in the order
/// support staff are taught to read them.
/// </summary>
/// <remarks>
/// <para>
/// The order is Overview, Performance, Services, Disk, Windows Update, Event
/// Logs, Network, System — narrowest to widest, identity first and inventory
/// last. It is fixed rather than user-sortable on purpose: a shared reading
/// order is what lets one engineer describe a cabinet to another over the phone.
/// </para>
/// <para>
/// The Event Logs section is filled on request rather than from routine
/// telemetry, and says so rather than drawing an empty panel. See
/// <see cref="SectionAvailability.OnDemandOnly"/> for why naming the reason
/// beats hiding the section: an empty panel and a healthy cabinet look the
/// same, and only one of them is good news.
/// </para>
/// </remarks>
public sealed partial class MachineTabViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly ActionInvoker _invoker;
    private readonly ISessionStore _session;
    private readonly TimeProvider _timeProvider;

    private IReadOnlyList<ActionCatalogEntryDto> _catalogue = Array.Empty<ActionCatalogEntryDto>();
    private CabinetDetailDto? _latest;

    /// <summary>
    /// Set while sections are being rebuilt, so selecting the first drive during
    /// the rebuild does not kick off a trend fetch that the load below is about
    /// to make redundant.
    /// </summary>
    private bool _suppressHistoryRequests;

    public MachineTabViewModel(
        IApiClient api,
        ActionInvoker invoker,
        ISessionStore session,
        ILiveRegionAnnouncer announcer,
        TimeProvider timeProvider)
        : base(announcer)
    {
        _api = api;
        _invoker = invoker;
        _session = session;
        _timeProvider = timeProvider;

        Sections = new ObservableCollection<MachineSectionViewModel>
        {
            Overview, Performance, Services, Disk, WindowsUpdate, EventLogs, Network, System
        };

        // The user changing drive or window starts a fetch that nothing is in a
        // position to await, so the task is kept rather than discarded: it is
        // what makes the load observable to a test and prevents an unobserved
        // exception if the fetch ever throws outside its own handler.
        Disk.HistoryRequested += (_, _) =>
        {
            if (!_suppressHistoryRequests)
            {
                PendingHistoryLoad = LoadSmartHistoryAsync();
            }
        };
    }

    public OverviewSectionViewModel Overview { get; } = new();
    public PerformanceSectionViewModel Performance { get; } = new();
    public ServicesSectionViewModel Services { get; } = new();
    public DiskSectionViewModel Disk { get; } = new();
    public WindowsUpdateSectionViewModel WindowsUpdate { get; } = new();
    public EventLogSectionViewModel EventLogs { get; } = new();
    public NetworkSectionViewModel Network { get; } = new();
    public SystemSectionViewModel System { get; } = new();

    public ObservableCollection<MachineSectionViewModel> Sections { get; }

    /// <summary>
    /// The SMART trend fetch currently in flight, or a completed task. Await it
    /// to be sure the Disk section's trend has settled — the view never needs
    /// to, but a caller that wants the tab fully loaded does.
    /// </summary>
    public Task PendingHistoryLoad { get; private set; } = Task.CompletedTask;

    [ObservableProperty]
    private Guid? _cabinetId;

    [ObservableProperty]
    private string _cabinetHostname = string.Empty;

    [ObservableProperty]
    private string _clientAndSite = string.Empty;

    /// <summary>
    /// How many sections arrive on request rather than with routine telemetry.
    /// </summary>
    /// <remarks>
    /// Event logs and process lists are read for one cabinet at a time by
    /// somebody already looking at it, so they travel on an action rather than
    /// on a check-in every five minutes from seven thousand cabinets. Surfaced
    /// at the top of the tab so an empty panel is never something a user
    /// discovers only by opening it and guessing.
    /// </remarks>
    public int OnDemandSectionCount => Sections.Count(s =>
        s.Availability.Kind == SectionAvailabilityKind.OnDemandOnly);

    public string? OnDemandSectionNote => OnDemandSectionCount == 0
        ? null
        : $"{OnDemandSectionCount} of {Sections.Count} sections are collected on request rather " +
          "than with every check-in. Each says which action fetches it. No values have been " +
          "substituted.";

    /// <summary>
    /// Loads the newest observation for one cabinet and rebuilds every section.
    /// </summary>
    /// <remarks>
    /// The catalogue is fetched once per session and reused: it is static data in
    /// server code, and re-fetching it per cabinet would add a round trip to
    /// every selection in the list for no new information.
    /// </remarks>
    public async Task LoadAsync(Guid cabinetId)
    {
        CabinetId = cabinetId;

        bool loaded = await RunAsync(async ct =>
        {
            if (_catalogue.Count == 0)
            {
                _catalogue = await _api.GetActionCatalogAsync(ct);
                BuildActions();
            }

            _latest = await _api.GetCabinetLatestAsync(cabinetId, ct);
        });

        if (!loaded)
        {
            // The error is already on screen. Sections are cleared so nothing
            // from the previously selected cabinet is left behind looking like
            // this one's data — the single most dangerous stale-state bug a tool
            // like this can have.
            _latest = null;
            ClearSections();
            return;
        }

        ApplyLatest();

        // Awaited rather than left running, so that a caller who has awaited
        // LoadAsync is looking at a tab that has finished loading. Fire and
        // forget here would mean the trend arriving at an unspecified moment
        // after the rest of the cabinet had rendered.
        PendingHistoryLoad = LoadSmartHistoryAsync();
        await PendingHistoryLoad;
    }

    /// <summary>
    /// Runs the one-click test of this cabinet's link to its site's sync
    /// cabinet.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The rep selects nothing and types nothing. The server resolves the
    /// target cabinet from this one's site and the address from that cabinet's
    /// last reported adapter — which is the whole point: a rep names a cabinet,
    /// never an address, and so cannot name the wrong one or reach outside the
    /// client the cabinet belongs to.
    /// </para>
    /// <para>
    /// It needs no approval. A ping is an observation, and making a rep wait
    /// for a second pair of eyes to find out whether a site can talk to itself
    /// would mean nobody ever runs it.
    /// </para>
    /// </remarks>
    [RelayCommand(CanExecute = nameof(CanTestSyncLink))]
    private async Task TestSyncLinkAsync()
    {
        if (CabinetId is not { } id)
        {
            return;
        }

        bool requested = await RunAsync(async ct =>
        {
            await _api.TestSyncLinkAsync(
                id,
                new TestSyncLinkRequest
                {
                    Reason = $"Checking whether {CabinetHostname} can reach its site's sync cabinet.",
                },
                ct);

            return true;
        });

        if (!requested)
        {
            return;
        }

        // The probe runs on the cabinet, so the answer arrives with a later
        // check-in rather than with this response. Saying so is better than a
        // spinner that stops with nothing visibly changed.
        Announcer.AnnounceImportant(
            $"A link test has been queued for {CabinetHostname}. The result arrives when the " +
            "cabinet next collects its actions; refresh this tab to see it.");
    }

    /// <summary>Whether there is a sync cabinet to test the link to.</summary>
    public bool CanTestSyncLink => Overview.CanTestSyncLink;

    /// <summary>Re-reads the same cabinet, for the Refresh button.</summary>
    [RelayCommand]
    private async Task RefreshAsync()
    {
        if (CabinetId is { } id)
        {
            await LoadAsync(id);
            Announcer.Announce($"Refreshed {CabinetHostname}. {Overview.Summarise()}");
        }
    }

    private void ApplyLatest()
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        CabinetHostname = _latest?.Cabinet.Hostname ?? string.Empty;
        ClientAndSite = _latest is null
            ? string.Empty
            : $"{_latest.Cabinet.ClientName} — {_latest.Cabinet.SiteName}";

        _suppressHistoryRequests = true;

        try
        {
            foreach (MachineSectionViewModel section in Sections)
            {
                section.Apply(_latest, nowUtc);
            }
        }
        finally
        {
            _suppressHistoryRequests = false;
        }

        foreach (SectionActionViewModel action in Sections.SelectMany(s => s.Actions))
        {
            action.RefreshAvailability();
        }

        OnPropertyChanged(nameof(OnDemandSectionCount));
        OnPropertyChanged(nameof(OnDemandSectionNote));
        OnPropertyChanged(nameof(CanTestSyncLink));
        TestSyncLinkCommand.NotifyCanExecuteChanged();
    }

    private void ClearSections()
    {
        _suppressHistoryRequests = true;

        try
        {
            foreach (MachineSectionViewModel section in Sections)
            {
                section.Apply(null, _timeProvider.GetUtcNow().UtcDateTime);
            }
        }
        finally
        {
            _suppressHistoryRequests = false;
        }

        Disk.ApplyHistory(Array.Empty<SmartRow>());
    }

    /// <summary>
    /// Fetches the SMART trend for the selected drive over the selected window.
    /// </summary>
    /// <remarks>
    /// Kept out of <see cref="ObservableViewModelBase.RunAsync"/> deliberately:
    /// the trend is one panel inside one section, and a failure to load it must
    /// not blank the whole Machine tab or claim the cabinet is unreachable. It
    /// reports into the section's own availability instead.
    /// </remarks>
    private async Task LoadSmartHistoryAsync()
    {
        if (CabinetId is not { } cabinetId)
        {
            return;
        }

        Disk.IsHistoryLoading = true;

        try
        {
            DateTimeOffset nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

            var query = new SmartHistoryQuery
            {
                DriveSerial = Disk.SelectedDrive?.Reading.DriveSerial,
                FromUtc = nowUtc.AddDays(-Math.Max(1, Disk.HistoryDays)),
                ToUtc = nowUtc,
                PageSize = 200
            };

            var readings = await _api.GetSmartHistoryAsync(cabinetId, query, CancellationToken.None);

            Disk.ApplyHistory(readings.Items.Select(r => new SmartRow(r)).ToList());
        }
        catch (ApiException ex)
        {
            Disk.FailHistory(ex.Message);
        }
        finally
        {
            Disk.IsHistoryLoading = false;
        }
    }

    /// <summary>
    /// Places each catalogued action in the section it belongs to.
    /// </summary>
    /// <remarks>
    /// There is no actions menu anywhere in this console. Restart Service lives
    /// under Services beside the service that is stopped; Reboot lives under
    /// System; Flush DNS lives under Network. An engineer reading a symptom
    /// should find the remedy in the same place, not by remembering a menu.
    /// </remarks>
    private void BuildActions()
    {
        Add(Services, ActionName.RestartService, Services.CurrentServiceParameters);
        Add(Services, ActionName.StartService, Services.CurrentServiceParameters);
        Add(Services, ActionName.StopService, Services.CurrentServiceParameters);

        Add(WindowsUpdate, ActionName.ScanForUpdates);
        Add(WindowsUpdate, ActionName.ScheduleUpdates);

        Add(Network, ActionName.FlushDnsCache);
        Add(Network, ActionName.RenewDhcpLease);

        Add(System, ActionName.RebootMachine);
        Add(System, ActionName.CollectDiagnosticBundle);

        // Every service action needs a selected row; none is selected yet.
        foreach (SectionActionViewModel action in Services.Actions)
        {
            action.IsContextSatisfied = false;
        }

        foreach (MachineSectionViewModel section in Sections)
        {
            section.NotifyActionsChanged();
        }
    }

    private void Add(
        MachineSectionViewModel section,
        ActionName action,
        Func<IReadOnlyDictionary<string, string>>? parameters = null)
    {
        ActionCatalogEntryDto? entry = _catalogue.FirstOrDefault(c => c.Action == action);

        if (entry is null)
        {
            // The server did not offer it. Nothing is drawn — the catalogue is
            // the server's, and an action the server has dropped must not
            // survive as a button in the client.
            return;
        }

        section.Actions.Add(new SectionActionViewModel(
            entry,
            () => _session.Role,
            (button, ct) => InvokeAsync(button, ct),
            parameters));
    }

    private async Task InvokeAsync(SectionActionViewModel button, CancellationToken ct)
    {
        if (CabinetId is not { } cabinetId)
        {
            return;
        }

        ActionInvocationResult result = await _invoker.InvokeAsync(
            button.Catalogue,
            cabinetId,
            CabinetHostname,
            ClientAndSite,
            button.ParameterFactory?.Invoke(),
            _latest?.LatestHeartbeat?.AnyUserLoggedOn,
            ct);

        if (result.FailureMessage is { } failure)
        {
            ErrorMessage = failure;
        }
        else if (result.Submitted)
        {
            ClearError();
        }

        ActionSubmitted?.Invoke(this, result);
    }

    /// <summary>
    /// Raised after every action attempt, so the shell can refresh the Approvals
    /// badge when a request lands in the queue.
    /// </summary>
    public event EventHandler<ActionInvocationResult>? ActionSubmitted;
}
