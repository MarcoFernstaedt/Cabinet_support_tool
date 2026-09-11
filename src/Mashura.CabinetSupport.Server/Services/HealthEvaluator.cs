using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Server.Services;

/// <summary>
/// Turns a cabinet's projected check-in columns into one status.
///
/// Deliberately a pure function over the projected columns only: the fleet
/// view evaluates this for every cabinet on the page, and it must never need
/// the stored payload to do it.
/// </summary>
public static class HealthEvaluator
{
    public const double CriticalFreeDiskPercent = 5d;
    public const double WarningFreeDiskPercent = 12d;
    public const double CriticalRamPercent = 95d;
    public const double WarningRamPercent = 88d;
    public const double CriticalCpuPercent = 95d;
    public const double WarningCpuPercent = 90d;
    public const int WarningPendingUpdates = 15;

    public static CabinetHealthStatus Evaluate(
        bool isActive,
        DateTime? lastCheckInUtc,
        DateTime nowUtc,
        int offlineAfterMinutes,
        double? cpuPercent,
        double? ramUsedPercent,
        double? minFreeDiskPercent,
        int? pendingUpdateCount,
        DiskHealthStatus? worstDiskHealth)
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
        if (worstDiskHealth is DiskHealthStatus.Failed or DiskHealthStatus.Critical)
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

        if (worstDiskHealth is DiskHealthStatus.Warning ||
            (minFreeDiskPercent is { } warnDisk && warnDisk <= WarningFreeDiskPercent) ||
            (ramUsedPercent is { } warnRam && warnRam >= WarningRamPercent) ||
            (cpuPercent is { } cpu && cpu >= WarningCpuPercent) ||
            (pendingUpdateCount is { } updates && updates >= WarningPendingUpdates))
        {
            return CabinetHealthStatus.Warning;
        }

        return CabinetHealthStatus.Healthy;
    }
}
