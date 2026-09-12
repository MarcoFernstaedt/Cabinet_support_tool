using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CommunityToolkit.Mvvm.ComponentModel;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// What is running on the cabinet, and the three ways of stopping it.
/// </summary>
/// <remarks>
/// <para>
/// Task Manager equivalence, which is most of what a remote desktop session was
/// being opened for. The list arrives on request rather than with routine
/// telemetry: it is large, it changes constantly, and it is read for one
/// cabinet at a time by somebody already looking at that cabinet.
/// </para>
/// <para>
/// Ending a process is offered from the row, never from a typed name. The
/// server keeps an allow-list and the agent keeps its own; a free-text box
/// would be a way of asking both of them to say no.
/// </para>
/// </remarks>
public sealed partial class ProcessSectionViewModel : MachineSectionViewModel
{
    private readonly List<ProcessRow> _all = new();

    /// <summary>Creates the section.</summary>
    public ProcessSectionViewModel()
        : base("Processes",
            "Running processes, fetched on request by the View process list action. " +
            "End a process, end every process of one name, and restart an application " +
            "are inside this section and act on the selected row.")
    {
        Availability = SectionAvailability.OnDemandOnly("The process list", "View process list");
    }

    /// <summary>The processes as last fetched.</summary>
    public ObservableCollection<ProcessRow> Processes { get; } = new();

    [ObservableProperty]
    private ProcessRow? _selectedProcess;

    [ObservableProperty]
    private string _filterText = string.Empty;

    /// <summary>
    /// UTC instant the list was fetched, or null when it has not been.
    /// </summary>
    /// <remarks>
    /// Shown beside the grid, because a process list is only true for the
    /// instant it was taken. A rep acting on a five-minute-old row is acting on
    /// a belief about a machine that has moved on, which is exactly why a kill
    /// by id carries the name it is expected to hold.
    /// </remarks>
    [ObservableProperty]
    private DateTimeOffset? _collectedUtc;

    /// <summary>How many processes were in the last fetch.</summary>
    public int TotalCount => _all.Count;

    /// <summary>One line describing what is on screen.</summary>
    public string FilterSummary => _all.Count == 0
        ? "No process list has been fetched for this cabinet yet."
        : $"Showing {Processes.Count} of {TotalCount} processes, read " +
          $"{Format.LocalTime(CollectedUtc)}.";

    /// <summary>
    /// The parameters an end-by-id action takes: the process id together with
    /// the name that id is expected to hold.
    /// </summary>
    /// <remarks>
    /// Both, always. Windows reuses process ids within minutes, so by the time
    /// the agent acts the id may name something else entirely; it re-reads the
    /// live process table and refuses the pair if the machine disagrees. An id
    /// on its own would not give it anything to disagree with.
    /// </remarks>
    public IReadOnlyDictionary<string, string> CurrentProcessIdParameters() =>
        SelectedProcess is null
            ? new Dictionary<string, string>()
            : new Dictionary<string, string>
            {
                [ActionParameterKeys.ProcessId] = SelectedProcess.Pid.ToString(),
                [ActionParameterKeys.ExpectedProcessName] = SelectedProcess.Name,
            };

    /// <summary>The parameters an end-by-name action takes.</summary>
    public IReadOnlyDictionary<string, string> CurrentProcessNameParameters() =>
        SelectedProcess is null
            ? new Dictionary<string, string>()
            : new Dictionary<string, string> { [ActionParameterKeys.ProcessName] = SelectedProcess.Name };

    /// <summary>The parameters a restart action takes.</summary>
    public IReadOnlyDictionary<string, string> CurrentApplicationParameters() =>
        SelectedProcess is null
            ? new Dictionary<string, string>()
            : new Dictionary<string, string>
            {
                [ActionParameterKeys.ApplicationName] = SelectedProcess.Name,
            };

    /// <summary>
    /// Replaces the list with what an on-demand fetch returned.
    /// </summary>
    /// <param name="processes">The processes the agent read.</param>
    /// <param name="collectedUtc">When it read them.</param>
    public void ApplyProcesses(IReadOnlyList<ProcessInfo> processes, DateTimeOffset collectedUtc)
    {
        _all.Clear();
        SelectedProcess = null;
        CollectedUtc = collectedUtc;

        _all.AddRange(processes
            .Select(p => new ProcessRow(p))
            // Heaviest first: a rep opening this list is nearly always looking
            // for the thing that is eating the machine.
            .OrderByDescending(p => p.Info.CpuPercent ?? -1)
            .ThenByDescending(p => p.Info.WorkingSetBytes ?? -1)
            .ThenBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase));

        Availability = _all.Count == 0
            ? SectionAvailability.Empty("processes")
            : SectionAvailability.Available;

        ApplyFilter();
    }

    /// <inheritdoc />
    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        // Deliberately ignores the telemetry. A process list belongs to the
        // moment it was fetched, and a check-in arriving must not make this
        // panel look filled or make a stale list look current.
        _all.Clear();
        Processes.Clear();
        SelectedProcess = null;
        CollectedUtc = null;

        Availability = latest is null
            ? SectionAvailability.NoCheckIn
            : SectionAvailability.OnDemandOnly("The process list", "View process list");

        OnPropertyChanged(nameof(TotalCount));
        OnPropertyChanged(nameof(FilterSummary));

        _ = nowUtc;
    }

    /// <inheritdoc />
    public override string Summarise() => _all.Count == 0
        ? $"{Title}: {Availability.Reason}"
        : $"{Title}: {FilterSummary}";

    partial void OnFilterTextChanged(string value) => ApplyFilter();

    partial void OnSelectedProcessChanged(ProcessRow? value)
    {
        // All three process actions act on the selected row. Nothing here takes
        // a typed name.
        foreach (SectionActionViewModel action in Actions)
        {
            action.IsContextSatisfied = value is not null;
        }
    }

    private void ApplyFilter()
    {
        IEnumerable<ProcessRow> filtered = _all;

        if (!string.IsNullOrWhiteSpace(FilterText))
        {
            string needle = FilterText.Trim();

            filtered = filtered.Where(p =>
                p.Name.Contains(needle, StringComparison.CurrentCultureIgnoreCase) ||
                p.Pid.ToString().Contains(needle, StringComparison.Ordinal));
        }

        Processes.Clear();

        foreach (ProcessRow row in filtered)
        {
            Processes.Add(row);
        }

        OnPropertyChanged(nameof(TotalCount));
        OnPropertyChanged(nameof(FilterSummary));
    }
}
