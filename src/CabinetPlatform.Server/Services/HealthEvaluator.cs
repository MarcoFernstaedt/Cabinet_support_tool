using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Services;

/// <summary>
/// Turns a cabinet's projected heartbeat columns into one status.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately a pure function over the projected columns only: the fleet view
/// evaluates this for every cabinet on the page, and it must never need a
/// stored payload to do it.
/// </para>
/// <para>
/// Every counter is nullable and a null one contributes nothing. A cabinet
/// whose disk reading failed is not a cabinet with plenty of disk.
/// </para>
/// </remarks>
public static class HealthEvaluator
{
    /// <summary>At or below this free disk percentage a cabinet is Critical.</summary>
    public const double CriticalFreeDiskPercent = 5d;

    /// <summary>At or below this free disk percentage a cabinet is Warning.</summary>
    public const double WarningFreeDiskPercent = 12d;

    /// <summary>At or above this memory percentage a cabinet is Critical.</summary>
    public const double CriticalRamPercent = 95d;

    /// <summary>At or above this memory percentage a cabinet is Warning.</summary>
    public const double WarningRamPercent = 88d;

    /// <summary>At or above this CPU percentage a cabinet is Warning.</summary>
    public const double WarningCpuPercent = 90d;

    /// <summary>At or above this many pending updates a cabinet is Warning.</summary>
    public const int WarningPendingUpdates = 15;

    /// <summary>
    /// Clock drift beyond this makes a cabinet Warning. Drift breaks site
    /// synchronisation and audit correlation, and neither failure announces
    /// itself.
    /// </summary>
    public static readonly TimeSpan WarningClockDrift = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Drift beyond this is Critical: at this distance the ordering of audit
    /// records against a dispensing system's own log stops being reliable.
    /// </summary>
    public static readonly TimeSpan CriticalClockDrift = TimeSpan.FromMinutes(10);

    /// <summary>Derives a cabinet's rolled-up health.</summary>
    /// <param name="isActive">Whether the cabinet is in service.</param>
    /// <param name="lastCheckInUtc">When it last reported.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="offlineAfterMinutes">Silence after which it counts as offline.</param>
    /// <param name="cpuPercent">CPU utilisation, or null if not read.</param>
    /// <param name="ramUsedPercent">Memory in use, or null if not read.</param>
    /// <param name="minFreeDiskPercent">Tightest volume's free space, or null if not read.</param>
    /// <param name="pendingUpdateCount">Pending updates, or null if the scan did not complete.</param>
    /// <param name="worstDiskHealth">Worst drive health across its disks.</param>
    /// <param name="clockDrift">Difference from the server's clock, or null if not measured.</param>
    public static CabinetHealthStatus Evaluate(
        bool isActive,
        DateTimeOffset? lastCheckInUtc,
        DateTimeOffset nowUtc,
        int offlineAfterMinutes,
        double? cpuPercent,
        double? ramUsedPercent,
        double? minFreeDiskPercent,
        int? pendingUpdateCount,
        DiskHealthStatus? worstDiskHealth,
        TimeSpan? clockDrift)
    {
        if (!isActive)
        {
            return CabinetHealthStatus.Unknown;
        }

        if (lastCheckInUtc is null)
        {
            return CabinetHealthStatus.Unknown;
        }

        if (lastCheckInUtc.Value < nowUtc.AddMinutes(-offlineAfterMinutes))
        {
            // Offline outranks everything else: stale numbers describe a
            // machine that may have changed completely since it last spoke.
            return CabinetHealthStatus.Offline;
        }

        // A failing drive in a DEA-compliant dispensing cabinet is a
        // chain-of-custody risk, not a disk-space inconvenience.
        if (worstDiskHealth is DiskHealthStatus.Failing)
        {
            return CabinetHealthStatus.Critical;
        }

        if (minFreeDiskPercent is { } freeDisk && freeDisk <= CriticalFreeDiskPercent)
        {
            return CabinetHealthStatus.Critical;
        }

        if (ramUsedPercent is { } ram && ram >= CriticalRamPercent)
        {
            return CabinetHealthStatus.Critical;
        }

        if (clockDrift is { } criticalDrift && criticalDrift.Duration() >= CriticalClockDrift)
        {
            return CabinetHealthStatus.Critical;
        }

        if (worstDiskHealth is DiskHealthStatus.Watch ||
            (minFreeDiskPercent is { } warnDisk && warnDisk <= WarningFreeDiskPercent) ||
            (ramUsedPercent is { } warnRam && warnRam >= WarningRamPercent) ||
            (cpuPercent is { } cpu && cpu >= WarningCpuPercent) ||
            (pendingUpdateCount is { } updates && updates >= WarningPendingUpdates) ||
            (clockDrift is { } warnDrift && warnDrift.Duration() >= WarningClockDrift))
        {
            return CabinetHealthStatus.Warning;
        }

        return CabinetHealthStatus.Healthy;
    }

    /// <summary>
    /// Picks the worse of two rolled-up statuses, for summarising a site.
    /// </summary>
    /// <remarks>
    /// The enum is not ordered by severity — Offline is 4 but is not worse than
    /// Critical for this purpose, and Unknown is 0 but is not the best case —
    /// so the ranking is explicit rather than a numeric comparison.
    /// </remarks>
    /// <param name="left">One status.</param>
    /// <param name="right">The other.</param>
    public static CabinetHealthStatus Worse(CabinetHealthStatus left, CabinetHealthStatus right) =>
        Rank(left) >= Rank(right) ? left : right;

    private static int Rank(CabinetHealthStatus status) => status switch
    {
        CabinetHealthStatus.Healthy => 0,
        CabinetHealthStatus.Unknown => 1,
        CabinetHealthStatus.Warning => 2,
        CabinetHealthStatus.Offline => 3,
        CabinetHealthStatus.Critical => 4,
        _ => 1,
    };
}
