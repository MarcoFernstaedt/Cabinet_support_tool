namespace CabinetPlatform.Console.Core.Presentation;

/// <summary>Why a Machine-tab section has no data to show.</summary>
public enum SectionAvailabilityKind
{
    /// <summary>Data is present.</summary>
    Available,

    /// <summary>
    /// The cabinet has never checked in, so there is nothing to show yet. A
    /// newly approved cabinet sits here until its agent's first check-in.
    /// </summary>
    NoCheckIn,

    /// <summary>
    /// The agent reported this section as failed to collect. The reason is the
    /// agent's own, passed through unchanged.
    /// </summary>
    CollectionFailed,

    /// <summary>
    /// The check-in succeeded and the section is genuinely empty — the machine
    /// has none of this thing. Distinct from every other case: no pending
    /// updates is good news, and must not read as a gap.
    /// </summary>
    Empty,

    /// <summary>
    /// This server build does not carry the section. The console names the gap
    /// rather than drawing an empty panel that looks like a healthy machine.
    /// </summary>
    NotCarriedByServer,

    /// <summary>
    /// The data exists but is fetched by an explicit action rather than
    /// arriving with routine telemetry.
    /// </summary>
    OnDemandOnly,
}

/// <summary>
/// A section's data state and, when it has none, the reason in words.
/// </summary>
/// <remarks>
/// This type exists because the alternatives are both lies. A blank panel says
/// "nothing to report" when the truth is "we do not know". A zero says
/// "measured, and it is zero" when the truth is "not measured" — and on a disk
/// free-space reading or a SMART reallocated-sector count, that difference is
/// the whole point of collecting the number.
/// </remarks>
public sealed record SectionAvailability(SectionAvailabilityKind Kind, string Reason)
{
    public bool HasData => Kind == SectionAvailabilityKind.Available;

    /// <summary>True when the view should show the reason instead of the data.</summary>
    public bool ShowsReason => Kind != SectionAvailabilityKind.Available;

    public static SectionAvailability Available { get; } =
        new(SectionAvailabilityKind.Available, string.Empty);

    public static SectionAvailability NoCheckIn { get; } = new(
        SectionAvailabilityKind.NoCheckIn,
        "This cabinet has not checked in yet, so nothing has been collected from it.");

    public static SectionAvailability Empty(string what) => new(
        SectionAvailabilityKind.Empty,
        $"The last check-in reported no {what}.");

    public static SectionAvailability Failed(string reason) => new(
        SectionAvailabilityKind.CollectionFailed,
        string.IsNullOrWhiteSpace(reason)
            ? "The agent could not collect this section and gave no reason."
            : reason);

    /// <summary>
    /// Names a section the agent collects but this server build does not store
    /// or serve. The wording says which component the gap is in, because
    /// "unavailable" alone sends a support engineer to check the cabinet for a
    /// fault that is not there.
    /// </summary>
    public static SectionAvailability NotCarriedByServer(string sectionName) => new(
        SectionAvailabilityKind.NotCarriedByServer,
        $"{sectionName} is not carried by this server build. The agent collects it, but the " +
        "server's check-in contract has no field for it, so there is nothing to display. " +
        "This is a gap in the platform, not a fault on the cabinet.");

    /// <summary>
    /// The section's data is fetched on request rather than routinely.
    /// </summary>
    /// <remarks>
    /// Not a gap. Event logs and process lists are large, change constantly,
    /// and are read for one cabinet at a time by somebody already looking at
    /// it — so they travel on an action, not on a check-in every five minutes
    /// from seven thousand cabinets.
    /// </remarks>
    /// <param name="sectionName">The section.</param>
    /// <param name="actionName">The action that fetches it.</param>
    public static SectionAvailability OnDemandOnly(string sectionName, string actionName) => new(
        SectionAvailabilityKind.OnDemandOnly,
        $"{sectionName} is collected on request rather than with every check-in. Use the " +
        $"\"{actionName}\" action below to fetch it for this cabinet.");

    /// <summary>
    /// The collector ran and failed, which the payload said in its own words.
    /// </summary>
    /// <param name="sectionName">The section.</param>
    public static SectionAvailability CollectorFailed(string sectionName) => new(
        SectionAvailabilityKind.NoCheckIn,
        $"{sectionName} could not be collected on the cabinet's last inventory check-in. The " +
        "cabinet reported the failure rather than reporting nothing, so this is a fault worth " +
        "looking into on the machine itself.");

    /// <summary>
    /// The inventory tier has not reported yet.
    /// </summary>
    /// <param name="sectionName">The section.</param>
    public static SectionAvailability NoInventoryYet(string sectionName) => new(
        SectionAvailabilityKind.NoCheckIn,
        $"{sectionName} arrives on the cabinet's slower inventory check-in, which has not run " +
        "since this cabinet was approved. It is not a fault on the cabinet.");
}
