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
/// Aggregate health across the fleet, filterable by client and site.
/// </summary>
/// <remarks>
/// <para>
/// This is the view a remote desktop session can never produce. Taking a session
/// into one clinic tells you about one cabinet; the question worth answering is
/// "which of the four hundred cabinets is about to cost someone a morning", and
/// that is only answerable in aggregate.
/// </para>
/// <para>
/// The server's fleet endpoint gives rolled-up health counts. The three
/// worklists — stale check-ins, pending updates, drives in Watch or Failing —
/// are built from the cabinet list under the same client and site filter, paged
/// through to completion. That is real data from the server, assembled here
/// because no single endpoint returns it; it is not a second source of truth.
/// </para>
/// </remarks>
public sealed partial class FleetTabViewModel : ObservableViewModelBase
{
    /// <summary>
    /// A cabinet silent for longer than this is listed as stale. It is the
    /// console's own reading line for a worklist, deliberately looser than the
    /// server's own offline threshold so a cabinet appears here to be looked at
    /// before it is formally offline.
    /// </summary>
    private const int StaleCheckInMinutes = 30;

    /// <summary>
    /// Hard ceiling on pages walked while assembling the worklists, so a
    /// mis-typed filter on a very large fleet cannot turn one click into
    /// hundreds of requests. When it bites, the view says so rather than
    /// presenting a partial list as complete.
    /// </summary>
    private const int MaxPagesToWalk = 20;

    private const int WalkPageSize = 200;

    private readonly IApiClient _api;
    private readonly TimeProvider _timeProvider;

    public FleetTabViewModel(IApiClient api, ILiveRegionAnnouncer announcer, TimeProvider timeProvider)
        : base(announcer)
    {
        _api = api;
        _timeProvider = timeProvider;
    }

    [ObservableProperty] private string _clientFilter = string.Empty;
    [ObservableProperty] private string _siteFilter = string.Empty;

    [ObservableProperty] private FleetHealthSummary? _summary;

    /// <summary>Cabinets that have not checked in recently.</summary>
    public ObservableCollection<CabinetRow> StaleCheckIns { get; } = new();

    /// <summary>Cabinets with at least one pending Windows update.</summary>
    public ObservableCollection<CabinetRow> PendingUpdates { get; } = new();

    /// <summary>Cabinets whose worst drive is in Watch, Failing or Failed.</summary>
    public ObservableCollection<CabinetRow> DrivesNeedingAttention { get; } = new();

    /// <summary>
    /// Counts by drive health across the filtered fleet, as a table rather than a
    /// chart. Every row carries its label, its glyph and its count, so it reads
    /// the same to a screen reader as it looks on screen.
    /// </summary>
    public ObservableCollection<FleetCountRow> DiskHealthCounts { get; } = new();

    /// <summary>Counts by rolled-up cabinet health, straight from the server.</summary>
    public ObservableCollection<FleetCountRow> CabinetHealthCounts { get; } = new();

    [ObservableProperty]
    private bool _worklistsTruncated;

    [ObservableProperty]
    private int _cabinetsExamined;

    public string TruncationNote =>
        $"Only the first {CabinetsExamined:N0} cabinets were examined for the worklists below. " +
        "Narrow the client or site filter for a complete list.";

    public string GeneratedAt => Summary is null
        ? Format.NotReported
        : Format.LocalTime(Summary.GeneratedUtc);

    /// <summary>
    /// The whole tab in one sentence, as a bindable property.
    /// </summary>
    /// <remarks>
    /// The same text the live region announces. Showing it on screen as well is
    /// deliberate: it is the most useful single line on the tab, and a sighted
    /// user should not have to assemble it from six grids either.
    /// </remarks>
    public string SummaryText => Summarise();

    [RelayCommand]
    private async Task RefreshAsync() => await LoadAsync();

    [RelayCommand]
    private async Task ClearFiltersAsync()
    {
        ClientFilter = string.Empty;
        SiteFilter = string.Empty;
        await LoadAsync();
    }

    public async Task LoadAsync()
    {
        string? client = string.IsNullOrWhiteSpace(ClientFilter) ? null : ClientFilter.Trim();
        string? site = string.IsNullOrWhiteSpace(SiteFilter) ? null : SiteFilter.Trim();

        bool loaded = await RunAsync(async ct =>
        {
            FleetHealthSummary summary = await _api.GetFleetHealthAsync(
                new FleetHealthQuery { ClientName = client, SiteName = site }, ct);

            List<CabinetSummary> cabinets = await WalkCabinetsAsync(client, site, ct);

            Summary = summary;
            ApplyCounts(summary, cabinets);
            ApplyWorklists(cabinets);
        });

        if (!loaded)
        {
            return;
        }

        Announcer.Announce(Summarise());
    }

    /// <summary>
    /// Pages through the cabinet list under the active filter.
    /// </summary>
    /// <remarks>
    /// Paged rather than asked for in one request because the server has no
    /// unbounded list endpoint — by design, the fleet is large enough that one
    /// would fall over. The walk stops at <see cref="MaxPagesToWalk"/> and says
    /// so rather than quietly showing an incomplete worklist.
    /// </remarks>
    private async Task<List<CabinetSummary>> WalkCabinetsAsync(
        string? client, string? site, CancellationToken ct)
    {
        List<CabinetSummary> all = new();
        bool truncated = false;

        for (int page = 1; page <= MaxPagesToWalk; page++)
        {
            PagedResult<CabinetSummary> batch = await _api.GetCabinetsAsync(
                new CabinetQuery
                {
                    ClientName = client,
                    SiteName = site,
                    Page = page,
                    PageSize = WalkPageSize
                },
                ct);

            all.AddRange(batch.Items);

            if (!batch.HasMore)
            {
                break;
            }

            if (page == MaxPagesToWalk)
            {
                truncated = true;
            }
        }

        WorklistsTruncated = truncated;
        CabinetsExamined = all.Count;

        return all;
    }

    private void ApplyCounts(FleetHealthSummary summary, IReadOnlyList<CabinetSummary> cabinets)
    {
        CabinetHealthCounts.Clear();

        // Straight from the server's own evaluation, so the console cannot
        // disagree with the authority about how many cabinets are critical.
        Add(CabinetHealthCounts, StatusPresentation.ForCabinet(CabinetHealthStatus.Healthy), summary.Healthy);
        Add(CabinetHealthCounts, StatusPresentation.ForCabinet(CabinetHealthStatus.Warning), summary.Warning);
        Add(CabinetHealthCounts, StatusPresentation.ForCabinet(CabinetHealthStatus.Critical), summary.Critical);
        Add(CabinetHealthCounts, StatusPresentation.ForCabinet(CabinetHealthStatus.Offline), summary.Offline);
        Add(CabinetHealthCounts, StatusPresentation.ForCabinet(CabinetHealthStatus.Unknown), summary.Unknown);
        Add(CabinetHealthCounts, new StatusPresentation("Inactive", "○", StatusSeverity.Neutral), summary.Inactive);

        DiskHealthCounts.Clear();

        // Disk health is not broken out by the fleet endpoint, so it is counted
        // from the same cabinet rows the worklists come from. Cabinets that have
        // never reported a drive verdict are counted as not reported rather than
        // folded into healthy.
        foreach (DiskHealthStatus status in new[]
                 {
                     DiskHealthStatus.Healthy, DiskHealthStatus.Warning,
                     DiskHealthStatus.Critical, DiskHealthStatus.Failed
                 })
        {
            Add(DiskHealthCounts,
                StatusPresentation.ForDisk(status),
                cabinets.Count(c => c.WorstDiskHealth == status));
        }

        Add(DiskHealthCounts,
            StatusPresentation.Unknown,
            cabinets.Count(c => c.WorstDiskHealth is null or DiskHealthStatus.Unknown));
    }

    private void ApplyWorklists(IReadOnlyList<CabinetSummary> cabinets)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        Fill(StaleCheckIns, cabinets
            .Where(c => c.IsActive)
            .Where(c => c.LastCheckInUtc is null ||
                        (nowUtc - DateTime.SpecifyKind(c.LastCheckInUtc.Value, DateTimeKind.Utc))
                        .TotalMinutes > StaleCheckInMinutes)
            // Never-checked-in cabinets first: an approved cabinet that has
            // never reported is a different and more urgent problem than one
            // that has gone quiet.
            .OrderBy(c => c.LastCheckInUtc ?? DateTime.MinValue), nowUtc);

        Fill(PendingUpdates, cabinets
            .Where(c => c.PendingUpdateCount is > 0)
            .OrderByDescending(c => c.PendingUpdateCount), nowUtc);

        Fill(DrivesNeedingAttention, cabinets
            .Where(c => c.WorstDiskHealth is DiskHealthStatus.Warning
                        or DiskHealthStatus.Critical or DiskHealthStatus.Failed)
            .OrderByDescending(c => c.WorstDiskHealth), nowUtc);

        OnPropertyChanged(nameof(GeneratedAt));
        OnPropertyChanged(nameof(TruncationNote));
        OnPropertyChanged(nameof(SummaryText));
    }

    private void Fill(
        ObservableCollection<CabinetRow> target, IEnumerable<CabinetSummary> source, DateTime nowUtc)
    {
        target.Clear();

        foreach (CabinetSummary cabinet in source)
        {
            target.Add(new CabinetRow(cabinet, nowUtc));
        }
    }

    private static void Add(
        ObservableCollection<FleetCountRow> target, StatusPresentation status, int count) =>
        target.Add(new FleetCountRow(status, count));

    /// <summary>
    /// The whole tab as one sentence. This is what a screen reader user hears
    /// after a refresh, and it has to be the headline rather than a recital of
    /// every count.
    /// </summary>
    public string Summarise()
    {
        if (Summary is not { } summary)
        {
            return "Fleet health not loaded.";
        }

        string scope = (ClientFilter, SiteFilter) switch
        {
            ({ Length: > 0 } c, { Length: > 0 } s) => $"{c}, {s}",
            ({ Length: > 0 } c, _) => c,
            (_, { Length: > 0 } s) => s,
            _ => "the whole fleet"
        };

        return
            $"Fleet health for {scope}. {summary.TotalCabinets:N0} cabinets: " +
            $"{summary.Healthy} healthy, {summary.Warning} warning, {summary.Critical} critical, " +
            $"{summary.Offline} offline, {summary.Unknown} unknown, {summary.Inactive} inactive. " +
            $"{StaleCheckIns.Count} have not checked in for {StaleCheckInMinutes} minutes. " +
            $"{PendingUpdates.Count} have pending updates. " +
            $"{DrivesNeedingAttention.Count} have a drive in watch or failing. " +
            $"{summary.ActionsAwaitingApproval} actions await approval. " +
            $"{summary.PendingRegistrations} agents await registration." +
            (WorklistsTruncated ? $" {TruncationNote}" : string.Empty);
    }
}

/// <summary>
/// One count in a fleet breakdown: label, shape and number together, so the
/// figure is never carried by a colour on its own.
/// </summary>
public sealed record FleetCountRow(StatusPresentation Status, int Count)
{
    public string Label => Status.Label;
    public string Glyph => Status.Glyph;
    public StatusSeverity Severity => Status.Severity;

    public string AccessibleSummary => $"{Status.Label}: {Count:N0}";
}
