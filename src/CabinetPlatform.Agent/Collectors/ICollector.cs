using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// One data category's collector. Implementations take every dependency
/// through their constructor so that each can be exercised on its own with
/// fixture data and no WMI provider present.
/// </summary>
public interface ICollector
{
    /// <summary>
    /// Identifies this collector in <see cref="CheckInPayload.SectionErrors"/>.
    /// Support staff read these names, so they match the payload's own sections.
    /// </summary>
    string SectionName { get; }

    /// <summary>
    /// Whether this collector runs on the five-minute heartbeat.
    /// </summary>
    /// <remarks>
    /// Most do not. A heartbeat is a small fixed sample by design: seven
    /// thousand cabinets at five minutes is about two million samples a day,
    /// and a service inventory or a Windows Update scan at that cadence would
    /// cost far more than it tells anyone. Those run on the slow tier.
    /// </remarks>
    bool RunsOnHeartbeat { get; }

    /// <summary>
    /// Fills this collector's section of the draft. Implementations may throw:
    /// the builder records the failure against this section and continues.
    /// </summary>
    /// <param name="draft">The payload being assembled.</param>
    /// <param name="tier">Which tier is being collected.</param>
    /// <param name="cancellationToken">Cancels the collection.</param>
    Task CollectAsync(CheckInDraft draft, CheckInTier tier, CancellationToken cancellationToken);
}

/// <summary>
/// The mutable payload being assembled during one check-in. Each collector
/// writes only its own section.
/// </summary>
public sealed class CheckInDraft
{
    public SystemInfo? System { get; set; }

    public PerformanceInfo? Performance { get; set; }

    public IReadOnlyList<ServiceInfo>? Services { get; set; }

    public IReadOnlyList<DiskInfo>? Disks { get; set; }

    public IReadOnlyList<EventLogEntry>? EventLogs { get; set; }

    public WindowsUpdateInfo? WindowsUpdate { get; set; }

    public NetworkInfo? Network { get; set; }
}

/// <summary>Section names used both by collectors and by the builder.</summary>
public static class CollectorSections
{
    public const string System = "System";
    public const string Performance = "Performance";
    public const string Services = "Services";
    public const string Disks = "Disks";
    public const string EventLogs = "EventLogs";
    public const string WindowsUpdate = "WindowsUpdate";
    public const string Network = "Network";
}
