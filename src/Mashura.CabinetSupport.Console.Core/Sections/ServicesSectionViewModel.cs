using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Mashura.CabinetSupport.Console.Core.Presentation;
using Mashura.CabinetSupport.Console.Core.Rows;
using Mashura.CabinetSupport.Contracts.Agent;
using Mashura.CabinetSupport.Contracts.Cabinets;

namespace Mashura.CabinetSupport.Console.Core.Sections;

/// <summary>
/// Windows services on the cabinet, with the filter support staff actually
/// need and the three actions that go with them.
/// </summary>
public sealed partial class ServicesSectionViewModel : MachineSectionViewModel
{
    private readonly List<ServiceRow> _all = new();

    public ServicesSectionViewModel()
        : base("Services",
            "Windows services from the last check-in, with a filter for services " +
            "set to start automatically that are currently stopped. " +
            "Restart, start and stop actions are inside this section.")
    {
    }

    public ObservableCollection<ServiceRow> Services { get; } = new();

    [ObservableProperty]
    private ServiceRow? _selectedService;

    [ObservableProperty]
    private string _filterText = string.Empty;

    /// <summary>
    /// The preset the brief calls for. Almost every "the cabinet is up but the
    /// application is not" call resolves to a service in exactly this state,
    /// and finding it by eye in a list of two hundred is the slow part.
    /// </summary>
    [ObservableProperty]
    private bool _showOnlyAutoStartStopped;

    public int TotalCount => _all.Count;

    public int AutoStartStoppedCount => _all.Count(s => s.IsAutoStartButStopped);

    /// <summary>
    /// Announced after every filter change, because the result of typing into a
    /// filter box is a change in a grid the user is not focused on.
    /// </summary>
    public string FilterSummary =>
        $"Showing {Services.Count} of {TotalCount} services." +
        (AutoStartStoppedCount > 0
            ? $" {AutoStartStoppedCount} set to start automatically are stopped."
            : string.Empty);

    partial void OnFilterTextChanged(string value) => ApplyFilter();

    partial void OnShowOnlyAutoStartStoppedChanged(bool value) => ApplyFilter();

    partial void OnSelectedServiceChanged(ServiceRow? value)
    {
        // The three service actions all need a service name, and the name comes
        // from the selected row. Nothing here accepts a typed service name: the
        // server keeps an allow-list, and a free-text box would just be a way
        // of asking it to reject things.
        foreach (SectionActionViewModel action in Actions)
        {
            action.IsContextSatisfied = value is not null;
        }
    }

    public override void Apply(CabinetLatestDto? latest, DateTime nowUtc)
    {
        _all.Clear();
        SelectedService = null;

        CheckInDetailDto? check = latest?.LatestCheckIn;

        if (check is null)
        {
            Availability = SectionAvailability.NoCheckIn;
            ApplyFilter();
            return;
        }

        List<ServiceSnapshot> snapshots = check.Payload?.Services ?? new List<ServiceSnapshot>();

        _all.AddRange(snapshots
            .Select(s => new ServiceRow(s))
            .OrderByDescending(s => s.IsAutoStartButStopped)
            .ThenBy(s => s.DisplayName, StringComparer.CurrentCultureIgnoreCase));

        Availability = _all.Count == 0
            ? SectionAvailability.Empty("services")
            : SectionAvailability.Available;

        ApplyFilter();
    }

    private void ApplyFilter()
    {
        IEnumerable<ServiceRow> filtered = _all;

        if (ShowOnlyAutoStartStopped)
        {
            filtered = filtered.Where(s => s.IsAutoStartButStopped);
        }

        if (!string.IsNullOrWhiteSpace(FilterText))
        {
            string needle = FilterText.Trim();

            filtered = filtered.Where(s =>
                s.DisplayName.Contains(needle, StringComparison.CurrentCultureIgnoreCase) ||
                s.ServiceName.Contains(needle, StringComparison.CurrentCultureIgnoreCase));
        }

        Services.Clear();

        foreach (ServiceRow row in filtered)
        {
            Services.Add(row);
        }

        OnPropertyChanged(nameof(TotalCount));
        OnPropertyChanged(nameof(AutoStartStoppedCount));
        OnPropertyChanged(nameof(FilterSummary));
    }

    /// <summary>
    /// The parameters for a service action: the selected row's service name and
    /// nothing else. The key is the only one the catalogue allows, and the
    /// server checks the value against its own allow-list before an agent ever
    /// sees it.
    /// </summary>
    public IReadOnlyDictionary<string, string> CurrentServiceParameters() =>
        SelectedService is { } row
            ? new Dictionary<string, string> { ["serviceName"] = row.ServiceName }
            : new Dictionary<string, string>();

    public override string Summarise() =>
        Availability.HasData
            ? FilterSummary
            : $"Services: {Availability.Reason}";
}
