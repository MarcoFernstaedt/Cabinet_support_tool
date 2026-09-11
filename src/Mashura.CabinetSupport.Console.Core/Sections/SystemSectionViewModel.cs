namespace Mashura.CabinetSupport.Console.Core.Sections;

/// <summary>
/// Time zone, clock drift, domain membership and installed software — and the
/// reboot action.
/// </summary>
/// <remarks>
/// As with Network, the readings are not carried by this server's contract and
/// the action is. Reboot is the most consequential thing this console can ask
/// for: disruptive, approval-required, maintenance-window-only, and refused
/// outright while anyone is logged on to the cabinet. It sits here, in the
/// section it belongs to, with all four of those facts on the button.
/// </remarks>
public sealed class SystemSectionViewModel : UnservedSectionViewModel
{
    public SystemSectionViewModel()
        : base("System",
            "Time zone, clock drift against the server, domain or workgroup, and installed " +
            "software inventory. Not carried by this server build. The reboot action is " +
            "inside this section and does work.")
    {
    }

    public string ActionsStillWorkNote =>
        "The reboot action below is fully supported by the server. Only the system readings " +
        "above are missing.";

    /// <summary>
    /// Clock drift is worth its own note: it is not merely missing, it is the
    /// one reading in this section whose absence has a consequence for the audit
    /// trail, since a cabinet whose clock has drifted files check-ins that sort
    /// wrongly against everything else.
    /// </summary>
    public string ClockDriftNote =>
        "Clock drift cannot be shown: the server stores the moment a check-in was collected " +
        "but not the cabinet's own reading of the current time, so there is nothing to compare " +
        "against. Drift still affects how check-ins sort in the audit trail.";
}
