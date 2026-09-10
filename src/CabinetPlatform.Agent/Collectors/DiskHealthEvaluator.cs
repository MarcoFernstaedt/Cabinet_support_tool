using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Turns S.M.A.R.T. readings into the health status support staff act on.
/// </summary>
public static class DiskHealthEvaluator
{
    /// <summary>
    /// Derives a status from a drive's SMART data.
    /// </summary>
    /// <remarks>
    /// The order matters. A drive predicting its own failure is Failing whatever
    /// else it reports. Reallocated or pending sectors above zero are Watch:
    /// not yet a failure, but the point at which a cabinet should be scheduled
    /// for a drive swap rather than discovered mid-dispense. Healthy is only
    /// claimed when something was actually read and everything read was clean —
    /// a drive whose SMART data is unavailable is Unknown, never Healthy.
    /// </remarks>
    public static DiskHealthStatus Evaluate(SmartInfo? smart)
    {
        if (smart is null)
        {
            return DiskHealthStatus.Unknown;
        }

        if (smart.OverallPredictFailure == true)
        {
            return DiskHealthStatus.Failing;
        }

        if (smart.ReallocatedSectorCount > 0 ||
            smart.PendingSectorCount > 0 ||
            smart.UncorrectableErrorCount > 0)
        {
            return DiskHealthStatus.Watch;
        }

        var readAnything = smart.OverallPredictFailure is not null
            || smart.ReallocatedSectorCount is not null
            || smart.PendingSectorCount is not null
            || smart.UncorrectableErrorCount is not null;

        // Every counter that could be read was clean.
        return readAnything ? DiskHealthStatus.Healthy : DiskHealthStatus.Unknown;
    }
}
