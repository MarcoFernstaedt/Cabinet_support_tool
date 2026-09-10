using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Translates the Windows Update Agent's own enumerations into the contract's.
/// </summary>
/// <remarks>
/// The two are deliberately mapped value by value rather than cast. WUA's
/// <c>OperationResultCode</c> starts at 0 for "not started" while the contract
/// reserves 0 for "unknown", so every value is off by one. A cast would compile,
/// run, and report every failed update as having succeeded with errors.
/// </remarks>
public static class WindowsUpdateResultMapping
{
    /// <summary>Maps WUA's OperationResultCode.</summary>
    public static UpdateResultCode MapResultCode(int? operationResultCode) => operationResultCode switch
    {
        0 => UpdateResultCode.NotStarted,
        1 => UpdateResultCode.InProgress,
        2 => UpdateResultCode.Succeeded,
        3 => UpdateResultCode.SucceededWithErrors,
        4 => UpdateResultCode.Failed,
        5 => UpdateResultCode.Aborted,
        _ => UpdateResultCode.Unknown,
    };

    /// <summary>
    /// Maps a WUA update category name onto the contract's classification.
    /// </summary>
    /// <remarks>
    /// WUA exposes classification only as a display name or a category GUID.
    /// Names are matched case-insensitively and in both singular and plural
    /// because the service is inconsistent about them across Windows versions.
    /// </remarks>
    public static UpdateClassification MapClassification(string? categoryName)
    {
        if (string.IsNullOrWhiteSpace(categoryName))
        {
            return UpdateClassification.Unknown;
        }

        var name = categoryName.Trim();

        return name switch
        {
            _ when Is(name, "Security Updates", "Security Update") => UpdateClassification.SecurityUpdate,
            _ when Is(name, "Critical Updates", "Critical Update") => UpdateClassification.CriticalUpdate,
            _ when Is(name, "Update Rollups", "Update Rollup") => UpdateClassification.UpdateRollup,
            _ when Is(name, "Service Packs", "Service Pack") => UpdateClassification.ServicePack,
            _ when Is(name, "Feature Packs", "Feature Pack") => UpdateClassification.FeaturePack,
            _ when Is(name, "Definition Updates", "Definition Update") => UpdateClassification.DefinitionUpdate,
            _ when Is(name, "Drivers", "Driver", "Driver Sets") => UpdateClassification.Driver,
            _ when Is(name, "Tools", "Tool") => UpdateClassification.Tool,
            _ when Is(name, "Upgrades", "Upgrade") => UpdateClassification.Upgrade,
            _ when Is(name, "Applications", "Application") => UpdateClassification.Application,
            _ when Is(name, "Updates", "Update") => UpdateClassification.Update,
            _ => UpdateClassification.Unknown,
        };
    }

    /// <summary>
    /// Picks the classification support cares about most from an update's
    /// categories.
    /// </summary>
    /// <remarks>
    /// An update belongs to several categories at once ("Windows 10",
    /// "Security Updates", "Updates"). The most specific one wins, so a security
    /// update is never filed as a generic update on a controlled-substance
    /// cabinet.
    /// </remarks>
    public static UpdateClassification SelectClassification(IEnumerable<string?> categoryNames)
    {
        var best = UpdateClassification.Unknown;

        foreach (var categoryName in categoryNames)
        {
            var candidate = MapClassification(categoryName);
            if (candidate == UpdateClassification.Unknown)
            {
                continue;
            }

            if (best == UpdateClassification.Unknown || Priority(candidate) < Priority(best))
            {
                best = candidate;
            }
        }

        return best;
    }

    /// <summary>Lower is more specific.</summary>
    private static int Priority(UpdateClassification classification) => classification switch
    {
        UpdateClassification.SecurityUpdate => 0,
        UpdateClassification.CriticalUpdate => 1,
        UpdateClassification.ServicePack => 2,
        UpdateClassification.Upgrade => 3,
        UpdateClassification.FeaturePack => 4,
        UpdateClassification.UpdateRollup => 5,
        UpdateClassification.Driver => 6,
        UpdateClassification.DefinitionUpdate => 7,
        UpdateClassification.Application => 8,
        UpdateClassification.Tool => 9,
        UpdateClassification.Update => 10,
        _ => int.MaxValue,
    };

    private static bool Is(string value, params string[] candidates)
        => candidates.Any(candidate => string.Equals(value, candidate, StringComparison.OrdinalIgnoreCase));
}
