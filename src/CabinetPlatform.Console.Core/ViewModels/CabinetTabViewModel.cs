using CabinetPlatform.Console.Core.Presentation;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// The Cabinet tab: cabinet-level hardware, as distinct from the Windows machine
/// the cabinet runs on.
/// </summary>
/// <remarks>
/// <para>
/// Empty in this build. Sensor and drawer discovery is not finished, the payload
/// shape for it is not designed, and the server's contract reserves nothing for
/// it. So this tab shows an empty state and no numbers at all.
/// </para>
/// <para>
/// Not stubbing it is a deliberate decision and the harder one to hold to in a
/// demo. A tab showing plausible temperatures and drawer states would look
/// better for ten minutes and then cost far more than it bought: someone would
/// screenshot it into a design review, someone else would build a threshold on
/// it, and the first real sensor reading would have to fight the fake one for
/// credibility. An empty tab is honest and costs nothing to replace.
/// </para>
/// <para>
/// The tab exists now, rather than being added later, so that the split between
/// machine-level and cabinet-level information is established in the UI from the
/// start. That split is how support staff are taught to reason about these
/// units: "the PC is fine, the cabinet is not" is a sentence the tool should
/// make it easy to arrive at.
/// </para>
/// </remarks>
public sealed class CabinetTabViewModel
{
    public string Title => "Cabinet";

    public string EmptyStateHeading => "No cabinet data collected yet.";

    public string EmptyStateDetail =>
        "Cabinet hardware telemetry — sensors, drawers and cubies — is not collected in this " +
        "build. Sensor and drawer discovery is incomplete, so there is no data to show and " +
        "nothing has been substituted for it.";

    /// <summary>
    /// Why the tab is here before it has anything in it. Shown to the user, not
    /// only written in a comment, because the question "why is this empty" is
    /// reasonable and deserves an answer on screen.
    /// </summary>
    public string WhyThisTabExists =>
        "This tab is separate from Machine on purpose. Machine describes the Windows PC inside " +
        "the unit; Cabinet describes the dispensing hardware. Keeping them apart from the start " +
        "means a fault can be placed on one or the other without ambiguity.";

    /// <summary>
    /// States plainly that nothing here is hardware actuation, since a tab about
    /// drawers is exactly where someone would look for a button to open one.
    /// </summary>
    public string NoActuationNote =>
        "This console has no drawer, lock or cubie controls, and will not gain any. Physical " +
        "access to a cabinet holding controlled substances is not something a remote support " +
        "tool should be able to grant.";

    public string AccessibleSummary =>
        $"{EmptyStateHeading} {EmptyStateDetail} {WhyThisTabExists} {NoActuationNote}";
}
