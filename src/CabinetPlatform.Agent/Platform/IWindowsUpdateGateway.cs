using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// The agent's view of the Windows Update Agent.
/// </summary>
/// <remarks>
/// Every method here is read-only or schedules work for Windows itself to do.
/// Nothing installs an update inline: an install that begins during a check-in
/// would reboot a cabinet at a time nobody chose.
/// </remarks>
public interface IWindowsUpdateGateway
{
    /// <summary>
    /// Searches for applicable updates that are not yet installed.
    /// </summary>
    /// <param name="online">
    /// When false, the search reads what Windows already knows and contacts
    /// nothing. Routine check-ins use that: a cabinet reaching out to Windows
    /// Update every five minutes would be slow and pointless. An explicit
    /// ScanForUpdates action passes true, because a support engineer asking a
    /// cabinet to scan means asking Windows to actually go and look.
    /// </param>
    IReadOnlyList<PendingUpdateInfo> SearchPendingUpdates(bool online, CancellationToken cancellationToken);

    /// <summary>Reads recent update history, newest first.</summary>
    /// <param name="maximumEntries">Ceiling on how many entries to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    IReadOnlyList<UpdateHistoryEntry> GetHistory(int maximumEntries, CancellationToken cancellationToken);

    /// <summary>
    /// Downloads and installs specific updates, now.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The one method here that changes the machine, and the only one that ever
    /// will. It installs the updates it is given and nothing else: an install
    /// that took "everything applicable" would install whatever had become
    /// applicable since the rep looked, which is not what anybody agreed to and
    /// not what the audit trail would then be describing.
    /// </para>
    /// <para>
    /// It does not restart the machine. Whether a restart is needed comes back
    /// on the outcome, and rebooting a cabinet is its own catalogued action
    /// with its own approval and its own logged-on check.
    /// </para>
    /// </remarks>
    /// <param name="updateIds">The updates to install, by Windows Update identifier.</param>
    /// <param name="cancellationToken">Cancels the install.</param>
    UpdateInstallOutcome InstallUpdates(
        IReadOnlyList<string> updateIds, CancellationToken cancellationToken);
}
