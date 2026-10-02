namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// Release capability ceiling. Configuration, roles and persisted approvals cannot expand it.
/// The legacy build exists only to exercise historical maintenance safety tests.
/// </summary>
public static class MonitoringBoundary
{
    /// <summary>True only when explicitly compiled for historical safety tests, never by configuration.</summary>
    public static bool LegacyMaintenanceTestBuild =>
#if LEGACY_MAINTENANCE_TESTS
        true;
#else
        false;
#endif

    /// <summary>The complete observational action allowlist for the monitoring release.</summary>
    public static bool IsObservation(ActionName action) => action is
        ActionName.GetProcessList or ActionName.CollectEventLogs or
        ActionName.RunEventLogView or ActionName.GetScheduledUpdates or
        ActionName.InspectFirewall or ActionName.GetDisplayDiagnostics or ActionName.GetWerMetadata;
}
