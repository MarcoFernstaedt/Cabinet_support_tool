using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// The cabinet list: searchable, filterable by client and site, and paged.
/// </summary>
/// <remarks>
/// Paged rather than virtualised over the whole fleet, because the server has no
/// unbounded list endpoint to virtualise against. Paging also keeps the grid a
/// fixed, announceable size, which matters more for a keyboard user than
/// seamless scrolling does.
/// </remarks>
public sealed partial class CabinetListViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly TimeProvider _timeProvider;

    public CabinetListViewModel(IApiClient api, ILiveRegionAnnouncer announcer, TimeProvider timeProvider)
        : base(announcer)
    {
        _api = api;
        _timeProvider = timeProvider;
    }

    public ObservableCollection<CabinetRow> Cabinets { get; } = new();

    /// <summary>
    /// Distinct clients seen so far, for the filter. Built from loaded pages
    /// rather than from a dedicated endpoint, because the server has none — so
    /// the list grows as the user pages, and the view says so.
    /// </summary>
    public ObservableCollection<string> KnownClients { get; } = new();

    public ObservableCollection<string> KnownSites { get; } = new();

    [ObservableProperty]
    private CabinetRow? _selectedCabinet;

    [ObservableProperty] private string _searchText = string.Empty;
    [ObservableProperty] private string? _clientFilter;
    [ObservableProperty] private string? _siteFilter;
    [ObservableProperty] private CabinetHealthStatus? _healthFilter;
    [ObservableProperty] private bool? _activeFilter = true;

    [ObservableProperty] private int _page = 1;
    [ObservableProperty] private int _pageSize = 50;
    [ObservableProperty] private int _totalCount;
    [ObservableProperty] private int _totalPages;

    public bool CanGoPrevious => Page > 1 && !IsLoading;
    public bool CanGoNext => Page < TotalPages && !IsLoading;

    /// <summary>
    /// Whether two cabinets on this page share a name.
    /// </summary>
    /// <remarks>
    /// Surfaced for the whole page as well as per row. A rep who has not
    /// noticed the per-row marker is exactly the one who needs telling.
    /// </remarks>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(DuplicateNameWarning))]
    private bool _hasDuplicateNamesOnPage;

    /// <summary>The banner shown above a page with colliding names.</summary>
    public string? DuplicateNameWarning => HasDuplicateNamesOnPage
        ? "Two or more cabinets on this page have the same name. Check the client and site before " +
          "acting on one."
        : null;

    public string PageSummary => TotalCount == 0
        ? "No cabinets match"
        : $"Page {Page} of {Math.Max(1, TotalPages)}, {TotalCount:N0} cabinets";

    /// <summary>
    /// Raised when the selection changes, so the shell can load the detail pane.
    /// </summary>
    public event EventHandler<Guid?>? SelectionChanged;

    public IReadOnlyList<int> PageSizes { get; } = new[] { 25, 50, 100, 200 };

    public IReadOnlyList<HealthChoice> HealthChoices { get; } = new[]
    {
        new HealthChoice(null, "Any health"),
        new HealthChoice(CabinetHealthStatus.Healthy, "Healthy"),
        new HealthChoice(CabinetHealthStatus.Warning, "Warning"),
        new HealthChoice(CabinetHealthStatus.Critical, "Critical"),
        new HealthChoice(CabinetHealthStatus.Offline, "Offline"),
        new HealthChoice(CabinetHealthStatus.Unknown, "Unknown")
    };

    public IReadOnlyList<ActiveChoice> ActiveChoices { get; } = new[]
    {
        new ActiveChoice(true, "Active only"),
        new ActiveChoice(false, "Inactive only"),
        new ActiveChoice(null, "Active and inactive")
    };

    public string ClientFilterNote =>
        "Client and site options are gathered from the pages loaded so far. Type a name into " +
        "search to reach a client that is not yet listed.";

    partial void OnSelectedCabinetChanged(CabinetRow? value)
    {
        SelectionChanged?.Invoke(this, value?.Id);

        if (value is not null)
        {
            // Selecting a row moves the whole right-hand pane. Announced,
            // because a keyboard user arrowing down the grid has no other signal
            // that the detail beside it has been replaced.
            // The whole path, not the hostname. A rep arrowing down a grid has
            // no other signal which client's cabinet the pane beside them has
            // just been replaced with.
            Announcer.Announce($"Selected {value.Display}. {value.AccessibleSummary}");
        }
    }

    [RelayCommand]
    private async Task SearchAsync()
    {
        Page = 1;
        await LoadAsync();
    }

    [RelayCommand]
    private async Task RefreshAsync() => await LoadAsync();

    [RelayCommand]
    private async Task ClearFiltersAsync()
    {
        SearchText = string.Empty;
        ClientFilter = null;
        SiteFilter = null;
        HealthFilter = null;
        ActiveFilter = true;
        Page = 1;
        await LoadAsync();
    }

    [RelayCommand(CanExecute = nameof(CanGoPrevious))]
    private async Task PreviousPageAsync()
    {
        Page--;
        await LoadAsync();
    }

    [RelayCommand(CanExecute = nameof(CanGoNext))]
    private async Task NextPageAsync()
    {
        Page++;
        await LoadAsync();
    }

    public async Task LoadAsync()
    {
        var query = new CabinetQuery
        {
            Search = string.IsNullOrWhiteSpace(SearchText) ? null : SearchText.Trim(),
            ClientName = string.IsNullOrWhiteSpace(ClientFilter) ? null : ClientFilter,
            SiteName = string.IsNullOrWhiteSpace(SiteFilter) ? null : SiteFilter,
            Health = HealthFilter,
            IsActive = ActiveFilter,
            Page = Page,
            PageSize = PageSize
        };

        PagedResult<CabinetSummary>? result = await RunAsync(ct => _api.GetCabinetsAsync(query, ct));

        if (result is null)
        {
            Cabinets.Clear();
            SelectedCabinet = null;
            TotalCount = 0;
            TotalPages = 0;
            RaisePagingChanged();
            return;
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        Guid? previouslySelected = SelectedCabinet?.Id;

        Cabinets.Clear();

        // Marked across the page, because the warning that matters is "two rows
        // in front of you carry one name", not "this name exists twice
        // somewhere among seven thousand cabinets".
        HashSet<string> duplicated = result.Items
            .GroupBy(c => c.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (CabinetRow row in result.Items.Select(
                     c => new CabinetRow(c, nowUtc, duplicated.Contains(c.DisplayName))))
        {
            Cabinets.Add(row);

            Remember(KnownClients, row.ClientName);
            Remember(KnownSites, row.SiteName);
        }

        HasDuplicateNamesOnPage = duplicated.Count > 0;

        TotalCount = result.TotalCount;
        TotalPages = result.TotalPages;

        // Keeping the selection across a refresh matters: a user who pressed
        // Refresh while reading a cabinet's disks should still be reading them
        // afterwards.
        SelectedCabinet = Cabinets.FirstOrDefault(c => c.Id == previouslySelected)
                          ?? Cabinets.FirstOrDefault();

        RaisePagingChanged();

        Announcer.Announce($"Cabinet list loaded. {PageSummary}. {DescribeFilters()}");
    }

    public string DescribeFilters()
    {
        List<string> parts = new();

        if (!string.IsNullOrWhiteSpace(SearchText))
        {
            parts.Add($"search \"{SearchText.Trim()}\"");
        }

        if (!string.IsNullOrWhiteSpace(ClientFilter))
        {
            parts.Add($"client {ClientFilter}");
        }

        if (!string.IsNullOrWhiteSpace(SiteFilter))
        {
            parts.Add($"site {SiteFilter}");
        }

        if (HealthFilter is { } health)
        {
            parts.Add($"health {StatusPresentation.ForCabinet(health).Label}");
        }

        parts.Add(ActiveFilter switch
        {
            true => "active only",
            false => "inactive only",
            null => "active and inactive"
        });

        return "Filters: " + string.Join("; ", parts) + ".";
    }

    private static void Remember(ObservableCollection<string> known, string value)
    {
        if (!string.IsNullOrWhiteSpace(value) && !known.Contains(value))
        {
            known.Add(value);
        }
    }

    protected override void OnLoadingChanged(bool isLoading) => RaisePagingChanged();

    private void RaisePagingChanged()
    {
        OnPropertyChanged(nameof(CanGoPrevious));
        OnPropertyChanged(nameof(CanGoNext));
        OnPropertyChanged(nameof(PageSummary));
        PreviousPageCommand.NotifyCanExecuteChanged();
        NextPageCommand.NotifyCanExecuteChanged();
    }
}

public sealed record HealthChoice(CabinetHealthStatus? Value, string Label);

public sealed record ActiveChoice(bool? Value, string Label);
