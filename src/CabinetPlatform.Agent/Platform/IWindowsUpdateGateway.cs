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
    /// <summary>Searches for applicable updates that are not yet installed.</summary>
    IReadOnlyList<PendingUpdateInfo> SearchPendingUpdates(CancellationToken cancellationToken);

    /// <summary>Reads recent update history, newest first.</summary>
    IReadOnlyList<UpdateHistoryEntry> GetHistory(int maximumEntries, CancellationToken cancellationToken);
}
