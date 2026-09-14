using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// The three ways a rep gets to a cabinet: search, the client hierarchy, and
/// what they were looking at last.
/// </summary>
/// <remarks>
/// <para>
/// One ViewModel rather than three, because they are one job. A rep on a call
/// starts wherever they happen to have something to go on — a name, a serial
/// number, a client — and switches route mid-sentence when the first thing
/// turns out to be wrong. Making them close one panel to open another would
/// cost more than the separation is worth.
/// </para>
/// <para>
/// Everything here identifies a cabinet by its full path. There is no route
/// through this screen that shows a bare hostname, because with seven thousand
/// cabinets a bare hostname is not an identification.
/// </para>
/// </remarks>
public sealed partial class CabinetFinderViewModel : ObservableViewModelBase
{
    /// <summary>Rows the search returns per page.</summary>
    /// <remarks>
    /// Enough that a client's cabinets usually fit on one page, small enough to
    /// scan. A rep who has to page through results has been given the wrong
    /// term, and the right fix is a better term rather than a longer list.
    /// </remarks>
    public const int SearchPageSize = 25;

    private readonly IApiClient _api;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the view model.</summary>
    /// <param name="api">The server.</param>
    /// <param name="announcer">The shared live region.</param>
    /// <param name="timeProvider">Clock.</param>
    public CabinetFinderViewModel(
        IApiClient api, ILiveRegionAnnouncer announcer, TimeProvider timeProvider)
        : base(announcer)
    {
        _api = api;
        _timeProvider = timeProvider;
    }

    /// <summary>Search results, each carrying its cabinet's full path.</summary>
    public ObservableCollection<CabinetSearchRow> Results { get; } = new();

    /// <summary>Clients, for the hierarchy browser's top level.</summary>
    public ObservableCollection<ClientSummary> Clients { get; } = new();

    /// <summary>The opened client's sites, each with its cabinets.</summary>
    public ObservableCollection<SiteWithCabinetsDto> HierarchySites { get; } = new();

    /// <summary>The cabinets this rep has opened most recently.</summary>
    public ObservableCollection<RecentCabinetRow> Recent { get; } = new();

    /// <summary>What the rep typed into the persistent search box.</summary>
    [ObservableProperty]
    private string _term = string.Empty;

    [ObservableProperty]
    private CabinetSearchRow? _selectedResult;

    [ObservableProperty]
    private ClientSummary? _selectedClient;

    [ObservableProperty]
    private int _page = 1;

    [ObservableProperty]
    private int _totalCount;

    [ObservableProperty]
    private int _totalPages;

    /// <summary>
    /// Whether any result in the current set shares its name with another.
    /// </summary>
    /// <remarks>
    /// Surfaced as a property of the whole result set, not only per row,
    /// because the warning that matters is "be careful, two of these look the
    /// same" and a rep who has not noticed the per-row marker is exactly the
    /// one who needs telling.
    /// </remarks>
    public bool ResultsContainDuplicateNames => Results.Any(r => r.Path.HostnameIsAmbiguous);

    /// <summary>The banner shown above a result set with colliding names.</summary>
    public string? DuplicateNameWarning => ResultsContainDuplicateNames
        ? "Two or more of these cabinets have the same name. Check the client and site before " +
          "acting on one."
        : null;

    /// <summary>One line describing the result set, for the screen and for a screen reader.</summary>
    public string ResultSummary => TotalCount switch
    {
        0 when string.IsNullOrWhiteSpace(Term) => "Type a client, site, cabinet name or serial number.",
        0 => $"Nothing matches \"{Term.Trim()}\".",
        1 => "1 cabinet matches.",
        _ => $"{TotalCount:N0} cabinets match. Showing page {Page} of {Math.Max(1, TotalPages)}.",
    };

    /// <summary>Whether there is a page before this one.</summary>
    public bool CanGoPrevious => Page > 1 && !IsLoading;

    /// <summary>Whether there is a page after this one.</summary>
    public bool CanGoNext => Page < TotalPages && !IsLoading;

    /// <summary>
    /// Raised when the rep picks a cabinet, by whichever route. The shell loads
    /// it.
    /// </summary>
    public event EventHandler<Guid>? CabinetChosen;

    /// <summary>Runs the search for the current term.</summary>
    public event EventHandler? SearchStarted;

    [RelayCommand]
    public async Task SearchAsync()
    {
        SearchStarted?.Invoke(this, EventArgs.Empty);
        Page = 1;
        await LoadResultsAsync();
    }

    /// <summary>Clears the term and the results.</summary>
    [RelayCommand]
    public void ClearSearch()
    {
        Term = string.Empty;
        Results.Clear();
        TotalCount = 0;
        TotalPages = 0;
        SelectedResult = null;
        RaiseResultsChanged();
        Announcer.Announce("Search cleared.");
    }

    /// <summary>Moves to the previous page of results.</summary>
    [RelayCommand(CanExecute = nameof(CanGoPrevious))]
    public async Task PreviousPageAsync()
    {
        Page--;
        await LoadResultsAsync();
    }

    /// <summary>Moves to the next page of results.</summary>
    [RelayCommand(CanExecute = nameof(CanGoNext))]
    public async Task NextPageAsync()
    {
        Page++;
        await LoadResultsAsync();
    }

    /// <summary>Opens the cabinet the rep has chosen.</summary>
    /// <param name="cabinetId">The cabinet.</param>
    [RelayCommand]
    public void Choose(Guid cabinetId)
    {
        if (cabinetId != Guid.Empty)
        {
            CabinetChosen?.Invoke(this, cabinetId);
        }
    }

    /// <summary>Loads the client list and this rep's recent cabinets.</summary>
    public async Task LoadAsync()
    {
        await LoadClientsAsync();
        await LoadRecentAsync();
    }

    /// <summary>Loads one page of search results.</summary>
    public async Task LoadResultsAsync()
    {
        var query = new CabinetSearchQuery
        {
            Term = string.IsNullOrWhiteSpace(Term) ? null : Term.Trim(),
            Page = Page,
            PageSize = SearchPageSize,
        };

        PagedResult<CabinetSearchHit>? result =
            await RunAsync(ct => _api.SearchCabinetsAsync(query, ct));

        Results.Clear();
        SelectedResult = null;

        if (result is null)
        {
            TotalCount = 0;
            TotalPages = 0;
            RaiseResultsChanged();
            return;
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        foreach (CabinetSearchHit hit in result.Items)
        {
            Results.Add(new CabinetSearchRow(hit, nowUtc));
        }

        TotalCount = result.TotalCount;
        TotalPages = result.TotalPages;
        SelectedResult = Results.FirstOrDefault();

        RaiseResultsChanged();

        // Announced including the duplicate warning, because a rep using a
        // screen reader has no other signal that two rows carry one name.
        Announcer.Announce(
            ResultSummary + (DuplicateNameWarning is { } warning ? " " + warning : string.Empty));
    }

    /// <summary>Loads the client list.</summary>
    public async Task LoadClientsAsync()
    {
        PagedResult<ClientSummary>? clients = await RunAsync(
            ct => _api.GetClientsAsync(new ClientQuery { PageSize = 200 }, ct));

        Clients.Clear();

        if (clients is null)
        {
            return;
        }

        foreach (ClientSummary client in clients.Items)
        {
            Clients.Add(client);
        }
    }

    /// <summary>Opens one client's sites and cabinets.</summary>
    /// <param name="clientId">The client.</param>
    public async Task LoadHierarchyAsync(Guid clientId)
    {
        ClientHierarchyDto? hierarchy = await RunAsync(ct => _api.GetClientHierarchyAsync(clientId, ct));

        HierarchySites.Clear();

        if (hierarchy is null)
        {
            return;
        }

        foreach (SiteWithCabinetsDto site in hierarchy.Sites)
        {
            HierarchySites.Add(site);
        }

        Announcer.Announce(
            $"{hierarchy.Client.Name}: {hierarchy.Client.SiteCount} site(s), " +
            $"{hierarchy.Client.CabinetCount} cabinet(s). Sites worst first, sync cabinet first at " +
            "each site.");
    }

    /// <summary>Loads this rep's recently opened cabinets.</summary>
    public async Task LoadRecentAsync()
    {
        IReadOnlyList<RecentCabinetDto>? recent = await RunAsync(
            ct => _api.GetRecentCabinetsAsync(10, ct));

        Recent.Clear();

        if (recent is null)
        {
            return;
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        foreach (RecentCabinetDto row in recent)
        {
            Recent.Add(new RecentCabinetRow(row, nowUtc));
        }
    }

    partial void OnSelectedClientChanged(ClientSummary? value)
    {
        if (value is not null)
        {
            PendingHierarchyLoad = LoadHierarchyAsync(value.Id);
        }
    }

    /// <summary>
    /// The hierarchy load started by the most recent client selection, or a
    /// completed task.
    /// </summary>
    /// <remarks>
    /// Kept rather than discarded: selecting a client is a user gesture with
    /// nothing to await it, so without this the load is unobservable and an
    /// exception escaping it would go unnoticed.
    /// </remarks>
    public Task PendingHierarchyLoad { get; private set; } = Task.CompletedTask;

    /// <inheritdoc />
    protected override void OnLoadingChanged(bool isLoading) => RaiseResultsChanged();

    private void RaiseResultsChanged()
    {
        OnPropertyChanged(nameof(ResultSummary));
        OnPropertyChanged(nameof(ResultsContainDuplicateNames));
        OnPropertyChanged(nameof(DuplicateNameWarning));
        OnPropertyChanged(nameof(CanGoPrevious));
        OnPropertyChanged(nameof(CanGoNext));
        PreviousPageCommand.NotifyCanExecuteChanged();
        NextPageCommand.NotifyCanExecuteChanged();
    }
}
