using System.Collections.ObjectModel;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
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
    private int _generation;
    private Guid? _appliedProcessActionId;
    public ObservableCollection<ActionRow> ActionHistory { get; } = new();
    [ObservableProperty] private ActionRow? _selectedAction;
    [ObservableProperty] private string _actionHistoryNote = "Refresh to retrieve action status and results.";

    [RelayCommand]
    private async Task RefreshActionsAsync()
    {
        if (CabinetId is not { } cabinetId || _latest is null) return;
        var generation = _generation;
        var page = await RunAsync(ct => _api.GetActionsAsync(new ActionQuery { CabinetId = cabinetId, PageSize = 100 }, ct));
        if (generation != _generation || page is null) return;
        ActionHistory.Clear();
        foreach (var action in page.Items.OrderByDescending(a => a.RequestedUtc))
            ActionHistory.Add(new ActionRow(action, _session.UserId, _timeProvider.GetUtcNow()));
        SelectedAction = ActionHistory.FirstOrDefault();
        ActionHistoryNote = page.HasMore
            ? "Showing the latest 100 requests. Older requests are not shown. Refresh to check completion."
            : "Refresh to check completion. Accepted or dispatched does not mean executed.";
        foreach (var group in page.Items.Where(a => a.CompletedUtc is not null &&
                         a.ResultStatus == ActionStatus.Succeeded &&
                         a.Action is ActionName.GetProcessList or ActionName.RunEventLogView or ActionName.InspectFirewall)
                     .OrderByDescending(a => a.RequestedUtc).GroupBy(a => a.Action))
        {
            foreach (var action in group)
            {
                if (generation != _generation) return;
                if (!await TryApplyActionResultAsync(action.Id)) continue;
                if (generation != _generation) return;
                ActionHistoryNote += action.Action == ActionName.InspectFirewall
                    ? $" Last completed firewall inspection envelope: {action.Id}, completed {Format.LocalTime(action.CompletedUtc)}. " +
                      "Read the native outcome in Windows firewall; successful delivery does not mean a readable or healthy firewall."
                    : $" Last successful {action.Action} snapshot: {action.Id}, " +
                      $"completed {Format.LocalTime(action.CompletedUtc)}. Newer requests may be pending or failed; see history.";
                break;
            }
        }
    }

    public bool CanAct => !IsLoading && _latest is not null && Path is not null;

    protected override void OnLoadingChanged(bool isLoading)
    {
        foreach (var action in Sections.SelectMany(s => s.Actions)) action.RefreshAvailability();
    }

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
        EventLogs.ConfigureViewCreation(api, session);

        Sections = new ObservableCollection<MachineSectionViewModel>
        {
            Overview, Performance, Processes, Services, Disk, WindowsUpdate, EventLogs, Network, Firewall, System
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

    /// <summary>Rolled-up state and the sync-link test.</summary>
    public OverviewSectionViewModel Overview { get; } = new();

    /// <summary>CPU, memory and page file.</summary>
    public PerformanceSectionViewModel Performance { get; } = new();

    /// <summary>What is running, and the three ways of stopping it.</summary>
    public ProcessSectionViewModel Processes { get; } = new();
    public ServicesSectionViewModel Services { get; } = new();
    public DiskSectionViewModel Disk { get; } = new();
    public WindowsUpdateSectionViewModel WindowsUpdate { get; } = new();
    public EventLogSectionViewModel EventLogs { get; } = new();
    public NetworkSectionViewModel Network { get; } = new();
    public FirewallSectionViewModel Firewall { get; } = new();
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
    /// The selected cabinet's full identifying path, or null when none is
    /// selected.
    /// </summary>
    /// <remarks>
    /// This is what the tab's persistent header shows and what every action
    /// dialog restates. It stays visible while the sections below it scroll,
    /// because a rep forty rows into an event log has had the cabinet's name
    /// off screen for some time and the next thing they do will be on whichever
    /// cabinet they believe they are looking at.
    /// </remarks>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HeaderPath), nameof(HeaderClientAndSite),
        nameof(HeaderCabinetName), nameof(HeaderRoleLabel), nameof(HeaderAccessibleSummary))]
    private CabinetPath? _path;

    /// <summary>The header's one-line identification.</summary>
    public string HeaderPath => CabinetIdentity.Line(Path);

    /// <summary>The header's client, site and department.</summary>
    public string HeaderClientAndSite => CabinetIdentity.ClientAndSite(Path);

    /// <summary>The header's cabinet name.</summary>
    public string HeaderCabinetName => Path?.CabinetName ?? string.Empty;

    /// <summary>The header's topology role.</summary>
    public string HeaderRoleLabel => Path is null ? string.Empty : CabinetIdentity.RoleLabel(Path.Role);

    /// <summary>The header as a sentence, for a screen reader.</summary>
    public string HeaderAccessibleSummary => CabinetIdentity.Spoken(Path);

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
        var generation = ++_generation;
        _latest = null;
        ClearSections();
        CabinetId = cabinetId;
        CabinetDetailDto? latest = null;
        ConnectivityStatusDto? connectivity = null;
        string? connectivityError = null;

        bool loaded = await RunAsync(async ct =>
        {
            if (_catalogue.Count == 0)
            {
                _catalogue = await _api.GetActionCatalogAsync(ct);
                BuildActions();
            }

            if (EventLogs.Views.Count == 0)
            {
                // Fetched once per session, like the catalogue. Views change
                // when a Supervisor edits one, which is rare, and re-fetching
                // per cabinet would add a round trip to every selection.
                EventLogs.ApplyViews(
                    (await _api.GetEventLogViewsAsync(new EventLogViewQuery { PageSize = 100 }, ct))
                    .Items);
            }

            latest = await _api.GetCabinetLatestAsync(cabinetId, ct);
            try
            {
                connectivity = await _api.GetConnectivityAsync(cabinetId, ct);
                if (connectivity.SourceCabinetId != cabinetId)
                {
                    connectivity = null;
                    connectivityError = "The response identity did not match the selected cabinet.";
                }
            }
            catch (ApiException ex) { connectivityError = ex.Message; }
            catch (NotSupportedException ex) { connectivityError = ex.Message; }
        });

        if (generation != _generation) return;
        _latest = latest;

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

        _connectivity = connectivity;
        _connectivityError = connectivityError;
        ApplyLatest();

        // Awaited rather than left running, so that a caller who has awaited
        // LoadAsync is looking at a tab that has finished loading. Fire and
        // forget here would mean the trend arriving at an unspecified moment
        // after the rest of the cabinet had rendered.
        PendingHistoryLoad = LoadSmartHistoryAsync();
        await PendingHistoryLoad;
        if (generation == _generation) await RefreshActionsAsync();
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
    public bool CanTestSyncLink => CanAct && Overview.CanTestSyncLink;

    /// <summary>
    /// Re-reads one action and, if it has finished and collected something,
    /// renders it into the section that asked for it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The on-demand sections work this way because the work happens on the
    /// cabinet, not in the response to the request. A rep presses "View process
    /// list", the action is queued, the agent collects it on its next poll, and
    /// the answer arrives some seconds later. The alternative — blocking the
    /// console until a machine somewhere in another country answers — is worse.
    /// </para>
    /// <para>
    /// Nothing is inferred from a result that is not there. A pending action
    /// leaves the section saying it is pending, which is the truth and is not
    /// the same as an empty grid.
    /// </para>
    /// </remarks>
    /// <param name="actionId">The action to re-read.</param>
    public async Task<bool> TryApplyActionResultAsync(Guid actionId)
    {
        var generation = _generation;
        ActionRequestView? action = await RunAsync(ct => _api.GetActionAsync(actionId, ct));

        if (generation != _generation || action?.CabinetId != CabinetId ||
            action?.CompletedUtc is null || action?.CollectedData is not { Length: > 0 } collected)
        {
            return false;
        }

        try
        {
            switch (action.Action)
            {
                case ActionName.InspectFirewall:
                    var inspection = JsonSerializer.Deserialize<FirewallInspection>(collected, ContractJson.Default);
                    if (action.ResultStatus == ActionStatus.Succeeded && inspection is not null && Firewall.TryApply(inspection))
                    {
                        Announcer.Announce(Firewall.Summarise());
                        return true;
                    }
                    return UnreadableResult(action.Id);

                case ActionName.GetProcessList:
                    IReadOnlyList<ProcessInfo>? processes =
                        JsonSerializer.Deserialize<IReadOnlyList<ProcessInfo>>(
                            collected, ContractJson.Default);

                    // JSON permits null array elements even when the CLR element
                    // type is non-nullable. Reject the whole snapshot before any
                    // section state is changed, rather than rendering partial data.
                    if (processes is not null && processes.All(p => p is not null))
                    {
                        // A status-only refresh of the same immutable result must
                        // not clear the operator's row selection. A full load clears
                        // CollectedUtc, and a new result has a new action identity.
                        if (_appliedProcessActionId == action.Id && Processes.CollectedUtc == action.CompletedUtc)
                            return true;
                        Processes.ApplyProcesses(
                            processes, action.CompletedUtc ?? _timeProvider.GetUtcNow());
                        _appliedProcessActionId = action.Id;
                        Announcer.Announce(Processes.Summarise());
                        return true;
                    }

                    return UnreadableResult(action.Id);

                case ActionName.RunEventLogView:
                    EventLogViewResultDto? result =
                        JsonSerializer.Deserialize<EventLogViewResultDto>(
                            collected, ContractJson.Default);

                    if (result is not null && result.Entries is not null &&
                        result.Entries.All(entry => entry is not null))
                    {
                        EventLogs.ApplyResult(result);
                        Announcer.Announce(EventLogs.Summarise());
                        return true;
                    }

                    return UnreadableResult(action.Id);

                default:
                    return false;
            }
        }
        catch (JsonException)
        {
            // A payload this build cannot read leaves the section saying it has
            // nothing, which is honest. Rendering half a grid from a document
            // we do not understand would be worse than rendering none.
            return UnreadableResult(action.Id);
        }
    }

    private bool UnreadableResult(Guid actionId)
    {
        string message = $" Result {actionId} is unreadable; no measurements from it were applied.";
        if (!ActionHistoryNote.Contains(message, StringComparison.Ordinal)) ActionHistoryNote += message;
        Announcer.AnnounceImportant(message.Trim());
        return false;
    }

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

    /// <summary>Snapshot provenance, never a claim that every metric was checked.</summary>
    public string MonitoringNote => _latest is null
        ? "Unknown: no cabinet snapshot loaded. A console request failure does not prove the cabinet is offline."
        : $"{Overview.Health.Label}. {MonitoringFreshness.LastSeen(_latest.Cabinet.LastCheckInUtc)}. " +
          $"Heartbeat collected: {Format.LocalTime(_latest.LatestHeartbeat?.CollectedAtUtc)}; " +
          $"received: {Format.LocalTime(_latest.LatestHeartbeat?.ReceivedUtc)}. " +
          $"Inventory last observed: {Format.LocalTime(_latest.CurrentInventory?.LastObservedUtc)}. " +
          "Historical observations below, not live health. Check-in time is not a per-metric successful check. " +
          "The console warns at 30 minutes; this is not an outage detection rule. Refresh to request new data.";

    /// <summary>Re-evaluate only presentation age; no network requests or cabinet actions.</summary>
    public void RefreshFreshness()
    {
        NotifyConnectivity();
        var previous = Overview.Health;
        Overview.Apply(_latest, _timeProvider.GetUtcNow());
        OnPropertyChanged(nameof(MonitoringNote));
        if (previous != Overview.Health) Announcer.AnnounceImportant(MonitoringNote);
    }

    private void ApplyLatest()
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        Path = _latest?.Path;
        CabinetHostname = _latest?.Cabinet.Hostname ?? string.Empty;
        ClientAndSite = CabinetIdentity.ClientAndSite(_latest?.Path);

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

        RefreshFreshness();
        OnPropertyChanged(nameof(OnDemandSectionCount));
        OnPropertyChanged(nameof(OnDemandSectionNote));
        OnPropertyChanged(nameof(CanTestSyncLink));
        TestSyncLinkCommand.NotifyCanExecuteChanged();
    }

    public override void Deactivate()
    {
        ++_generation;
        base.Deactivate();
    }

    public void Reset()
    {
        Deactivate();
        CabinetId = null;
        _latest = null;
        _catalogue = Array.Empty<ActionCatalogEntryDto>();
        ClearSections();
        EventLogs.Views.Clear();
        Processes.FilterText = string.Empty;
        foreach (var section in Sections)
        {
            section.Actions.Clear();
            section.NotifyActionsChanged();
        }
        ClearError();
    }

    private void ClearSections()
    {
        ClearConnectivity();
        ActionHistory.Clear();
        SelectedAction = null;
        Path = null;
        CabinetHostname = string.Empty;
        ClientAndSite = string.Empty;
        foreach (var action in Sections.SelectMany(s => s.Actions)) action.RefreshAvailability();
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
        OnPropertyChanged(nameof(MonitoringNote));
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

        var generation = _generation;
        var drive = Disk.SelectedDrive;
        var days = Disk.HistoryDays;
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

            if (generation != _generation || drive != Disk.SelectedDrive || days != Disk.HistoryDays) return;
            Disk.ApplyHistory(readings.Items.Select(r => new SmartRow(r)).ToList());
        }
        catch (ApiException ex)
        {
            if (generation == _generation && drive == Disk.SelectedDrive && days == Disk.HistoryDays) Disk.FailHistory(ex.Message);
        }
        finally
        {
            if (generation == _generation && drive == Disk.SelectedDrive && days == Disk.HistoryDays) Disk.IsHistoryLoading = false;
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
        // Processes. All three act on the selected row; none accepts a typed
        // name, because the server and the agent both keep allow-lists and a
        // free-text box would only be a way of asking them to say no.
        Add(Processes, ActionName.GetProcessList);
        Add(Processes, ActionName.KillProcess, Processes.CurrentProcessIdParameters);
        Add(Processes, ActionName.KillProcessByName, Processes.CurrentProcessNameParameters);
        Add(Processes, ActionName.RestartApplication, Processes.CurrentApplicationParameters);

        Add(Services, ActionName.RestartService, Services.CurrentServiceParameters);
        Add(Services, ActionName.StartService, Services.CurrentServiceParameters);
        Add(Services, ActionName.StopService, Services.CurrentServiceParameters);
        Add(Services, ActionName.SetServiceStartType, Services.CurrentStartTypeParameters);

        Add(WindowsUpdate, ActionName.ScanForUpdates);
        Add(WindowsUpdate, ActionName.ScheduleUpdates);
        Add(WindowsUpdate, ActionName.InstallUpdatesNow);
        Add(WindowsUpdate, ActionName.CancelScheduledUpdates);
        Add(WindowsUpdate, ActionName.GetScheduledUpdates);

        Add(EventLogs, ActionName.RunEventLogView, EventLogs.CurrentViewParameters);
        Add(EventLogs, ActionName.CollectEventLogs);

        Add(Firewall, ActionName.InspectFirewall);

        Add(Network, ActionName.FlushDnsCache);
        Add(Network, ActionName.RenewDhcpLease);
        Add(Network, ActionName.PingHost);
        Add(Network, ActionName.TraceRoute);
        Add(Network, ActionName.TestPortConnectivity);
        Add(Network, ActionName.SetDnsServers);
        Add(Network, ActionName.SetStaticIpAddress);
        Add(Network, ActionName.SetAdapterToDhcp);

        Add(System, ActionName.RebootMachine);
        Add(System, ActionName.CollectDiagnosticBundle);

        // Deliberately absent: OpenDrawer, UnlockLock and OpenCubie. The server
        // refuses all three at every role, no agent has an executor for any of
        // them, and there is no control for them here. Do not add one.

        // Every service and process action needs a selected row; none is
        // selected yet. The fetch actions are not gated on one.
        foreach (SectionActionViewModel action in Services.Actions)
        {
            action.IsContextSatisfied = false;
        }

        foreach (SectionActionViewModel action in Processes.Actions
                     .Where(a => a.Catalogue.Action != ActionName.GetProcessList))
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
            parameters) { TargetAvailable = () => CanAct });
    }

    private async Task InvokeAsync(SectionActionViewModel button, CancellationToken ct)
    {
        if (!CanAct || Path is not { } path)
        {
            return;
        }

        ActionInvocationResult result = await _invoker.InvokeAsync(
            button.Catalogue,
            path,
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
        if (result.Submitted && Path == path) await RefreshActionsAsync();
    }

    /// <summary>
    /// Raised after every action attempt, so the shell can refresh the Approvals
    /// badge when a request lands in the queue.
    /// </summary>
    public event EventHandler<ActionInvocationResult>? ActionSubmitted;
}
