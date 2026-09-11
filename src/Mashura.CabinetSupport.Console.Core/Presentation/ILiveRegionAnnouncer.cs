namespace Mashura.CabinetSupport.Console.Core.Presentation;

/// <summary>
/// Announces the outcome of asynchronous work to assistive technology.
/// </summary>
/// <remarks>
/// <para>
/// Without this, everything this console does well is invisible to a screen
/// reader. A grid that silently repopulates, a reboot request that silently
/// enters the approval queue, a filter that silently narrows 400 cabinets to 3 —
/// each is a change of state announced by nothing, so the user's only way to
/// find out is to go hunting through the control they were not focused on.
/// </para>
/// <para>
/// ViewModels depend on the interface; the WPF layer maps it onto a UI
/// Automation live region. That keeps the announcement text — the part that has
/// to be worded well — in the ViewModel where it can be asserted in a test.
/// </para>
/// </remarks>
public interface ILiveRegionAnnouncer
{
    /// <summary>
    /// Announces routine progress: data refreshed, a filter applied, a page
    /// turned. Polite, so it waits for the user to stop typing.
    /// </summary>
    void Announce(string message);

    /// <summary>
    /// Announces something the user must not miss: an action submitted, a
    /// refusal from the server, a failure. Interrupts.
    /// </summary>
    void AnnounceImportant(string message);
}
