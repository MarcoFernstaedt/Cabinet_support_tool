using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// The audit trail, filterable by cabinet, actor, date range and the
/// Observed / Caused distinction.
/// </summary>
/// <remarks>
/// <para>
/// Supervisor-only at the server. A Tier 1 or Tier 2 user reaching this tab is
/// told that in plain words rather than shown an empty grid — a permissions
/// boundary the user cannot see is one they will mistake for a bug.
/// </para>
/// <para>
/// Observed against Caused is the filter that matters most here. "Show me
/// everything that changed state on this cabinet last Tuesday" is the question a
/// compliance reviewer arrives with, and it is answered by one radio button,
/// not by reading 4,000 rows of read-only access records.
/// </para>
/// </remarks>
public sealed partial class AuditTabViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly TimeProvider _timeProvider;

    public AuditTabViewModel(IApiClient api, ILiveRegionAnnouncer announcer, TimeProvider timeProvider)
        : base(announcer)
    {
        _api = api;
        _timeProvider = timeProvider;

        // A week, which is inside the server's bound and is the window a support
        // engineer usually wants. Unbounded is not on offer: the server refuses
        // it rather than clamping, so offering it here would only produce an
        // error the user did not ask for.
        //
        // Shown in the reader's own zone: the rep picks the window they mean,
        // and the client converts it back to UTC on the way out.
        ToLocal = timeProvider.GetUtcNow().ToLocalTime();
        FromLocal = ToLocal.AddDays(-7);
    }

    public ObservableCollection<AuditRow> Entries { get; } = new();

    /// <summary>
    /// Cabinets to filter by, supplied by the shell so this tab does not fetch
    /// the list a second time.
    /// </summary>
    public ObservableCollection<CabinetSummary> Cabinets { get; } = new();

    [ObservableProperty] private CabinetSummary? _selectedCabinet;
    [ObservableProperty] private string _actorId = string.Empty;
    [ObservableProperty] private AuditEventKind? _eventKind;

    // The trail's action column is an ActionName, not free text, so the filter
    // is a picker over the catalog rather than a substring match that can only
    // ever match or silently miss.
    [ObservableProperty] private ActionName? _actionFilter;
    [ObservableProperty] private AuditResult? _result;
    [ObservableProperty] private DateTimeOffset _fromLocal;
    [ObservableProperty] private DateTimeOffset _toLocal;

    [ObservableProperty] private int _page = 1;
    [ObservableProperty] private int _pageSize = 50;
    [ObservableProperty] private int _totalCount;
    [ObservableProperty] private int _totalPages;

    /// <summary>
    /// True when the server refused the whole tab on role grounds, so the view
    /// can explain rather than show an empty grid.
    /// </summary>
    [ObservableProperty]
    private bool _isForbidden;

    public bool CanGoPrevious => Page > 1 && !IsLoading;
    public bool CanGoNext => Page < TotalPages && !IsLoading;

    public string PageSummary => TotalCount == 0
        ? "No entries"
        : $"Page {Page} of {Math.Max(1, TotalPages)}, {TotalCount:N0} entries";

    /// <summary>
    /// The three page-size choices. Capped well inside the server's maximum of
    /// 200 so a filter mistake cannot turn into a grid nobody can navigate.
    /// </summary>
    public IReadOnlyList<int> PageSizes { get; } = new[] { 25, 50, 100 };

    public IReadOnlyList<AuditKindChoice> EventKindChoices { get; } = new[]
    {
        new AuditKindChoice(null, "Both"),
        new AuditKindChoice(AuditEventKind.Observed, "Observed — a read, nothing changed"),
        new AuditKindChoice(AuditEventKind.Caused, "Caused — cabinet state changed")
    };

    /// <summary>
    /// The action filter's options, built from the catalog enum itself so the
    /// picker cannot drift from what the trail can actually contain.
    /// </summary>
    public IReadOnlyList<AuditActionChoice> ActionChoices { get; } =
        new[] { new AuditActionChoice(null, "Any action") }
            .Concat(Enum.GetValues<ActionName>().Select(a => new AuditActionChoice(a, a.ToString())))
            .ToArray();

    /// <summary>The result filter's options.</summary>
    public IReadOnlyList<AuditResultChoice> ResultChoices { get; } = new[]
    {
        new AuditResultChoice(null, "Any result"),
        new AuditResultChoice(AuditResult.Success, "Success"),
        new AuditResultChoice(AuditResult.Denied, "Denied"),
        new AuditResultChoice(AuditResult.Failure, "Failure")
    };

    [RelayCommand]
    private async Task SearchAsync()
    {
        Page = 1;
        await LoadAsync();
    }

    [RelayCommand]
    private async Task RefreshAsync() => await LoadAsync();

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

    /// <summary>
    /// Narrows to one cabinet and reloads. Called when the user asks for the
    /// audit trail of the cabinet they are looking at, which is the shortest
    /// path from a symptom to its history.
    /// </summary>
    public async Task ShowForCabinetAsync(Guid cabinetId)
    {
        // A cabinet the list has not loaded is still worth filtering by: the
        // rep came here from that cabinet's own page. The placeholder carries
        // its id and says plainly that the rest is not loaded, rather than
        // inventing a hostname or a health verdict for it.
        SelectedCabinet = Cabinets.FirstOrDefault(c => c.Id == cabinetId) ?? Placeholder(cabinetId);
        Page = 1;
        await LoadAsync();
    }

    public async Task LoadAsync()
    {
        IsForbidden = false;

        var query = new AuditQuery
        {
            CabinetId = SelectedCabinet?.Id == Guid.Empty ? null : SelectedCabinet?.Id,
            ActorId = string.IsNullOrWhiteSpace(ActorId) ? null : ActorId.Trim(),
            EventKind = EventKind,
            Result = Result,
            Action = ActionFilter,
            FromUtc = FromLocal.ToUniversalTime(),
            ToUtc = ToLocal.ToUniversalTime(),
            Page = Page,
            PageSize = PageSize
        };

        PagedResult<AuditEntryDto>? result = await RunAsync(ct => _api.GetAuditAsync(query, ct));

        if (result is null)
        {
            // Role refusal is not a fault, and must not be reported as one.
            IsForbidden = LastFailure == ApiFailure.Forbidden;

            Entries.Clear();
            TotalCount = 0;
            TotalPages = 0;
            RaisePagingChanged();
            return;
        }

        Entries.Clear();

        foreach (AuditRow row in result.Items.Select(e => new AuditRow(e)))
        {
            Entries.Add(row);
        }

        TotalCount = result.TotalCount;
        TotalPages = result.TotalPages;
        RaisePagingChanged();

        Announcer.Announce(
            $"Audit trail loaded. {PageSummary}. {DescribeFilters()}");
    }

    /// <summary>
    /// The active filters in words. Announced with the result count so a screen
    /// reader user knows which query produced the number they just heard.
    /// </summary>
    public string DescribeFilters()
    {
        List<string> parts = new()
        {
            $"{FromLocal:yyyy-MM-dd HH:mm} to {ToLocal:yyyy-MM-dd HH:mm} local time"
        };

        if (SelectedCabinet is { } cabinet && cabinet.Id != Guid.Empty)
        {
            parts.Add($"cabinet {(string.IsNullOrWhiteSpace(cabinet.Hostname) ? cabinet.Id.ToString() : cabinet.Hostname)}");
        }

        if (!string.IsNullOrWhiteSpace(ActorId))
        {
            parts.Add($"actor {ActorId.Trim()}");
        }

        if (EventKind is { } kind)
        {
            parts.Add(StatusPresentation.ForAuditKind(kind).Label);
        }

        if (Result is { } result)
        {
            parts.Add($"result {StatusPresentation.ForAuditResult(result).Label}");
        }

        if (ActionFilter is { } action)
        {
            parts.Add($"action {action}");
        }

        return "Filters: " + string.Join("; ", parts) + ".";
    }

    public string ForbiddenExplanation =>
        "The audit trail is restricted to Supervisors. The server refused this request, which " +
        "is correct — your role does not include audit access. Ask a Supervisor if you need an " +
        "entry looked up.";

    protected override void OnLoadingChanged(bool isLoading) => RaisePagingChanged();

    private void RaisePagingChanged()
    {
        OnPropertyChanged(nameof(CanGoPrevious));
        OnPropertyChanged(nameof(CanGoNext));
        OnPropertyChanged(nameof(PageSummary));
        PreviousPageCommand.NotifyCanExecuteChanged();
        NextPageCommand.NotifyCanExecuteChanged();
    }
    /// <summary>
    /// A stand-in for a cabinet the list has not loaded, carrying its id and
    /// nothing invented.
    /// </summary>
    /// <param name="cabinetId">The cabinet to filter by.</param>
    private static CabinetSummary Placeholder(Guid cabinetId) => new()
    {
        Id = cabinetId,
        MachineId = string.Empty,
        Hostname = "(not loaded)",
        ClientName = string.Empty,
        SiteName = string.Empty,
        SiteId = Guid.Empty,
        Role = CabinetRole.Unknown,
        IsActive = true,
        Health = CabinetHealthStatus.Unknown,
        WorstDiskHealth = DiskHealthStatus.Unknown,
    };
}

/// <summary>A named choice in the result filter.</summary>
public sealed record AuditResultChoice(AuditResult? Value, string Label);

/// <summary>A named choice in the observed-or-caused filter.</summary>
/// <param name="Value">The kind, or null for both.</param>
/// <param name="Label">What the picker shows.</param>
public sealed record AuditKindChoice(AuditEventKind? Value, string Label);

/// <summary>A named choice in the action filter.</summary>
/// <param name="Value">The action, or null for any.</param>
/// <param name="Label">What the picker shows.</param>
public sealed record AuditActionChoice(ActionName? Value, string Label);
