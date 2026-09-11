namespace Mashura.CabinetSupport.Console.Core.Sections;

/// <summary>
/// Errors and warnings from the cabinet's Windows event logs.
/// </summary>
/// <remarks>
/// <para>
/// Empty in this build, and honest about why. The agent has an event log
/// collector; this server's <c>CheckInRequest</c> has no field to carry its
/// output, so no event log entry ever reaches the console.
/// </para>
/// <para>
/// The section exists anyway. Support staff are taught to read a cabinet in this
/// order, and a Machine tab that silently omits event logs teaches them that
/// this platform does not do event logs — which is a worse outcome than a panel
/// that says the gap is in the server's contract and will close when it does.
/// </para>
/// </remarks>
public sealed class EventLogSectionViewModel : UnservedSectionViewModel
{
    public EventLogSectionViewModel()
        : base("Event Logs",
            "Errors and warnings from the cabinet's Windows event logs, filterable by log " +
            "and time window. Not carried by this server build.")
    {
    }
}
