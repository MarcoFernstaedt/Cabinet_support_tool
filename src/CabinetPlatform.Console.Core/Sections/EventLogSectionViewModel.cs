using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CommunityToolkit.Mvvm.ComponentModel;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// The cabinet's Windows event logs, read through a named view.
/// </summary>
/// <remarks>
/// <para>
/// A view rather than a log picker. Support does not want one error firehose:
/// the question is nearly always about a specific subsystem — the CUBEX
/// application, Windows Update, the disk stack, the service control manager —
/// and the records that answer it are a few dozen among tens of thousands. The
/// views are written once by a Supervisor who knew the answer and shared with
/// everyone.
/// </para>
/// <para>
/// Fetched on request, never with routine telemetry, and never stored. Seven
/// thousand cabinets sending a day of records every few minutes would dominate
/// storage while being read for a handful of them.
/// </para>
/// <para>
/// Nothing in this section accepts a query expression. A rep picks a view and a
/// window; the server expands the view's stored fields and the agent builds its
/// own query from them.
/// </para>
/// </remarks>
public sealed partial class EventLogSectionViewModel : MachineSectionViewModel
{
    /// <summary>Time windows a rep may pick, in hours.</summary>
    /// <remarks>
    /// Fixed choices rather than a free number, because the useful windows are
    /// few and named: this shift, today, since the weekend, since the upgrade.
    /// </remarks>
    public IReadOnlyList<EventLogWindowChoice> WindowChoices { get; } = new[]
    {
        new EventLogWindowChoice(null, "The view's own default"),
        new EventLogWindowChoice(1, "Last hour"),
        new EventLogWindowChoice(8, "Last 8 hours"),
        new EventLogWindowChoice(24, "Last 24 hours"),
        new EventLogWindowChoice(72, "Last 3 days"),
        new EventLogWindowChoice(168, "Last 7 days"),
    };

    /// <summary>Creates the section.</summary>
    public EventLogSectionViewModel()
        : base("Event Logs",
            "Windows event log records, read through a named view. Pick a view and a time " +
            "window, then run it. Views are defined by Supervisors and shared across every rep; " +
            "the records are fetched on request and are never stored.")
    {
        Availability = SectionAvailability.OnDemandOnly("Event log records", "Run an event log view");
    }

    /// <summary>The views this rep may run.</summary>
    public ObservableCollection<EventLogViewDto> Views { get; } = new();

    /// <summary>Discovered native channels. Record browsing still uses the saved view contract.</summary>
    public ObservableCollection<EventChannelInfo> Channels { get; } = new();

    /// <summary>The records the last run returned.</summary>
    public ObservableCollection<EventLogEntry> Entries { get; } = new();

    [ObservableProperty]
    private EventLogViewDto? _selectedView;

    [ObservableProperty]
    private EventLogWindowChoice? _selectedWindow;

    /// <summary>The name of the view whose records are on screen.</summary>
    [ObservableProperty]
    private string? _resultViewName;

    /// <summary>Whether the last run hit the view's record ceiling.</summary>
    [ObservableProperty]
    private bool _resultTruncated;

    /// <summary>The window the last run actually searched, in hours.</summary>
    [ObservableProperty]
    private int _resultWindowHours;

    /// <summary>
    /// The parameters a run takes: which view, and the window when the rep
    /// overrode the view's default.
    /// </summary>
    /// <remarks>
    /// The view is named by identifier. Its fields are expanded by the server
    /// from what a Supervisor stored; a request that tried to carry its own
    /// definition is refused.
    /// </remarks>
    public IReadOnlyDictionary<string, string> CurrentViewParameters()
    {
        if (SelectedView is null)
        {
            return new Dictionary<string, string>();
        }

        var parameters = new Dictionary<string, string>
        {
            [ActionParameterKeys.EventLogViewId] = SelectedView.Id.ToString(),
        };

        if (SelectedWindow?.Hours is { } hours)
        {
            parameters[ActionParameterKeys.HoursOfHistory] = hours.ToString();
        }

        return parameters;
    }

    /// <summary>Availability of native channel discovery on the last view result.</summary>
    public string ChannelDiscoverySummary { get; private set; } = string.Empty;

    /// <summary>One line describing what is on screen.</summary>
    public string ResultSummary => RecordSummary + (ChannelDiscoverySummary.Length == 0 ? string.Empty : " " + ChannelDiscoverySummary);

    private string RecordSummary => Entries.Count == 0
        ? Availability.Reason ?? "No records have been fetched for this cabinet yet."
        : ResultTruncated
            ? $"'{ResultViewName}' matched at least {Entries.Count} record(s) over " +
              $"{ResultWindowHours}h; the newest {Entries.Count} are shown."
            : $"'{ResultViewName}' matched {Entries.Count} record(s) over {ResultWindowHours}h.";

    /// <summary>Replaces the list of views a rep may run.</summary>
    /// <param name="views">The views the server offers.</param>
    public void ApplyViews(IReadOnlyList<EventLogViewDto> views)
    {
        Guid? previous = SelectedView?.Id;

        Views.Clear();

        foreach (EventLogViewDto view in views)
        {
            Views.Add(view);
        }

        SelectedView = Views.FirstOrDefault(v => v.Id == previous) ?? Views.FirstOrDefault();
        SelectedWindow ??= WindowChoices[0];
    }

    /// <summary>Shows what a run returned.</summary>
    /// <param name="result">The records and what produced them.</param>
    public void ApplyResult(EventLogViewResultDto result)
    {
        Channels.Clear();
        EventChannelDiscoveryResult? discovery = result.ChannelDiscovery;
        if (discovery is not null && (discovery.Channels is null || discovery.Channels.Any(c => c is null)))
        {
            discovery = new EventChannelDiscoveryResult();
        }
        if (discovery is not null)
        {
            foreach (EventChannelInfo channel in discovery.Channels)
            {
                Channels.Add(channel);
            }
        }
        ChannelDiscoverySummary = discovery?.Status switch
        {
            EventChannelDiscoveryStatus.AccessDenied => "Channel discovery: access denied for the agent identity.",
            EventChannelDiscoveryStatus.Unavailable => "Channel discovery unavailable; this is not a complete channel inventory.",
            EventChannelDiscoveryStatus.Available =>
                $"Channels: {Channels.Count(c => c.Access == EventChannelAccess.Readable)} readable, " +
                $"{Channels.Count(c => c.Access == EventChannelAccess.AccessDenied)} access denied, " +
                $"{Channels.Count(c => c.Access == EventChannelAccess.Disabled)} disabled, " +
                $"{Channels.Count(c => c.Access == EventChannelAccess.Unavailable)} unavailable." +
                (discovery.Truncated ? " Discovery limit reached; inventory is incomplete." : string.Empty),
            _ => string.Empty,
        };
        OnPropertyChanged(nameof(ChannelDiscoverySummary));
        Entries.Clear();

        foreach (EventLogEntry entry in result.Entries)
        {
            Entries.Add(entry);
        }

        ResultViewName = result.ViewDisplayName;
        ResultTruncated = result.Truncated;
        ResultWindowHours = result.WindowHours;

        // An empty result is stated as an empty result rather than left looking
        // like a section nobody has run: "this view matched nothing" and "you
        // have not looked" are different facts, and only one of them is good
        // news.
        Availability = Entries.Count == 0
            ? SectionAvailability.Empty($"records matching '{result.ViewDisplayName}'")
            : SectionAvailability.Available;

        OnPropertyChanged(nameof(ResultSummary));
    }

    /// <inheritdoc />
    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        // Deliberately ignores the telemetry: nothing in it belongs to this
        // section, and a check-in arriving must not make the panel look filled
        // or leave another cabinet's records on screen.
        Channels.Clear();
        ChannelDiscoverySummary = string.Empty;
        OnPropertyChanged(nameof(ChannelDiscoverySummary));
        Entries.Clear();
        ResultViewName = null;
        ResultTruncated = false;
        ResultWindowHours = 0;

        Availability = latest is null
            ? SectionAvailability.NoCheckIn
            : SectionAvailability.OnDemandOnly("Event log records", "Run an event log view");

        OnPropertyChanged(nameof(ResultSummary));

        _ = nowUtc;
    }

    /// <inheritdoc />
    public override string Summarise() => Entries.Count == 0
        ? $"{Title}: {Availability.Reason}"
        : $"{Title}: {ResultSummary}";

    partial void OnSelectedViewChanged(EventLogViewDto? value)
    {
        foreach (SectionActionViewModel action in Actions)
        {
            action.IsContextSatisfied = value is not null;
        }
    }
}

/// <summary>One time window a rep may pick for a view.</summary>
/// <param name="Hours">The window, or null to use the view's own default.</param>
/// <param name="Label">How it reads on screen.</param>
public sealed record EventLogWindowChoice(int? Hours, string Label);
