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
    IReadOnlyList<UpdateHistoryEntry> GetHistory(int maximumEntries, CancellationToken cancellationToken);
}
