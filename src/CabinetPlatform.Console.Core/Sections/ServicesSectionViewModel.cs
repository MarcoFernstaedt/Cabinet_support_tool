using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Sections;

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

    partial void OnSelectedStartTypeChanged(ServiceStartType value) =>
        OnPropertyChanged(nameof(StartTypeWarning));

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

    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        _all.Clear();
        SelectedService = null;

        // Services are inventory: which ones exist and how they are configured
        // is configuration, and it is stored only when it changes.
        IReadOnlyList<ServiceInfo>? snapshots = latest?.CurrentInventory?.Services;

        if (latest is null)
        {
            Availability = SectionAvailability.NoCheckIn;
            ApplyFilter();
            return;
        }

        if (snapshots is null)
        {
            Availability = latest.CurrentInventory is null
                ? SectionAvailability.NoInventoryYet("Services")
                : SectionAvailability.CollectorFailed("Services");
            ApplyFilter();
            return;
        }

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
    /// <summary>The parameters the three run-state actions take.</summary>
    public IReadOnlyDictionary<string, string> CurrentServiceParameters() =>
        SelectedService is { } row
            ? new Dictionary<string, string>
            {
                [Contracts.Actions.ActionParameterKeys.ServiceName] = row.ServiceName,
            }
            : new Dictionary<string, string>();

    /// <summary>
    /// The start types a rep may set, and the one currently selected.
    /// </summary>
    /// <remarks>
    /// Boot and System are absent on purpose. They are driver load orders:
    /// setting an ordinary service to one does not make it start earlier, it
    /// makes the machine fail to boot. The server refuses both, and offering
    /// them here would only produce a refusal a rep had to interpret.
    /// </remarks>
    public IReadOnlyList<ServiceStartType> StartTypeChoices { get; } = new[]
    {
        ServiceStartType.Automatic,
        ServiceStartType.AutomaticDelayed,
        ServiceStartType.Manual,
        ServiceStartType.Disabled,
    };

    /// <summary>The start type a set-start-type action would apply.</summary>
    [ObservableProperty]
    private ServiceStartType _selectedStartType = ServiceStartType.Automatic;

    /// <summary>The parameters the set-start-type action takes.</summary>
    public IReadOnlyDictionary<string, string> CurrentStartTypeParameters() =>
        SelectedService is { } row
            ? new Dictionary<string, string>
            {
                [Contracts.Actions.ActionParameterKeys.ServiceName] = row.ServiceName,
                [Contracts.Actions.ActionParameterKeys.StartType] = SelectedStartType.ToString(),
            }
            : new Dictionary<string, string>();

    /// <summary>
    /// The warning shown beside the start-type control when Disabled is chosen.
    /// </summary>
    /// <remarks>
    /// The consequence of disabling a service is delayed and invisible: nothing
    /// changes now, and the cabinet comes back from its next reboot without the
    /// service. Saying so at the moment of choosing is the only place it helps.
    /// </remarks>
    public string? StartTypeWarning => SelectedStartType == ServiceStartType.Disabled
        ? "Disabled means the service will not start at the next reboot either. Nothing about the " +
          "cabinet changes until then, which is what makes this easy to forget."
        : null;

    public override string Summarise() =>
        Availability.HasData
            ? FilterSummary
            : $"Services: {Availability.Reason}";
}
