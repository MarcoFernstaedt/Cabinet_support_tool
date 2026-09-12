using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// Errors and warnings from the cabinet's Windows event logs.
/// </summary>
/// <remarks>
/// <para>
/// Fetched on request, never with routine telemetry. Seven thousand cabinets
/// sending a day of records every few minutes would dominate storage while
/// being read for a handful of them — and the handful is always identifiable in
/// advance, because a rep is looking at one cabinet precisely because something
/// is wrong with it.
/// </para>
/// <para>
/// So the section explains how to get the records rather than showing an empty
/// panel, and the action that fetches them sits inside it.
/// </para>
/// </remarks>
public sealed class EventLogSectionViewModel : MachineSectionViewModel
{
    /// <summary>Creates the section.</summary>
    public EventLogSectionViewModel()
        : base("Event Logs",
            "Errors and warnings from the cabinet's Windows event logs, fetched on request " +
            "by the View event logs action and filterable by log, level and time window.")
    {
        Availability = SectionAvailability.OnDemandOnly("Event logs", "View event logs");
    }

    /// <inheritdoc />
    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        // Deliberately ignores the telemetry: nothing in it belongs to this
        // section, and a check-in arriving must not make the panel look filled.
        Availability = latest is null
            ? SectionAvailability.NoCheckIn
            : SectionAvailability.OnDemandOnly("Event logs", "View event logs");

        _ = nowUtc;
    }

    /// <inheritdoc />
    public override string Summarise() => $"{Title}: {Availability.Reason}";
}
