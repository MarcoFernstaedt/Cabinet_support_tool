using CommunityToolkit.Mvvm.ComponentModel;
using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// One collapsible section of the Machine tab.
/// </summary>
/// <remarks>
/// <para>
/// Every section answers the same three questions in the same way: is there
/// data, if not then why not, and what may be done here. Sharing the base means
/// a section cannot accidentally render an empty panel where it should render a
/// reason — the only way to have no data is to set an
/// <see cref="SectionAvailability"/> that says why.
/// </para>
/// <para>
/// Actions live on the section they belong to, never in a separate menu. The
/// engineer who has just read "Dnscache: stopped" should be able to act on that
/// line without first working out which top-level menu restarts a service.
/// </para>
/// </remarks>
public abstract partial class MachineSectionViewModel : ObservableObject
{
    protected MachineSectionViewModel(string title, string accessibleDescription)
    {
        Title = title;
        AccessibleDescription = accessibleDescription;
    }

    /// <summary>Heading text, and the section's automation name.</summary>
    public string Title { get; }

    /// <summary>
    /// What the section contains, read out when focus reaches the header. The
    /// heading alone ("System") does not tell a screen reader user whether the
    /// thing they are looking for is inside.
    /// </summary>
    public string AccessibleDescription { get; }

    /// <summary>
    /// Expanded state. Overview starts open; everything else starts closed, so
    /// keyboard users reach the tab's other controls without arrowing through
    /// several hundred grid rows they did not ask for.
    /// </summary>
    [ObservableProperty]
    private bool _isExpanded;

    [ObservableProperty]
    private SectionAvailability _availability = SectionAvailability.NoCheckIn;

    /// <summary>Actions offered inside this section.</summary>
    public ObservableCollection<SectionActionViewModel> Actions { get; } = new();

    public bool HasActions => Actions.Count > 0;

    /// <summary>
    /// Re-raises <see cref="HasActions"/> once the owning tab has populated
    /// <see cref="Actions"/> from the server's catalogue. Public because the
    /// catalogue arrives after construction and the section itself never adds
    /// its own buttons.
    /// </summary>
    public void NotifyActionsChanged() => OnPropertyChanged(nameof(HasActions));

    /// <summary>
    /// Rebuilds from the newest observation. <paramref name="latest"/> is null
    /// when the cabinet has never checked in.
    /// </summary>
    public abstract void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc);

    /// <summary>
    /// The section's state as one sentence for the live region, so a refresh
    /// announces what actually changed rather than "data refreshed".
    /// </summary>
    public abstract string Summarise();

    /// <summary>Marks the section as having nothing to show.</summary>
    /// <param name="latest">The cabinet's newest state.</param>
    protected void SetNoData(CabinetDetailDto? latest)
    {
        Availability = latest?.LatestHeartbeat is null
            ? SectionAvailability.NoCheckIn
            : SectionAvailability.Available;
    }
}
