using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>
/// One heartbeat row: the small, fixed sample a cabinet sends every few
/// minutes.
/// </summary>
/// <remarks>
/// <para>
/// Seven thousand cabinets at a five-minute cadence is about two million
/// samples a day. Storing a full payload for each produces terabytes within
/// weeks, so a heartbeat is stored as typed columns and no JSON document. The
/// heavy sections travel on their own slower tiers.
/// </para>
/// <para>
/// Every counter is nullable. A counter the agent could not read is
/// <see langword="null"/> here and must be rendered as "not read", never as
/// zero: on CPU percent, zero reads as an idle machine.
/// </para>
/// </remarks>
public sealed record HeartbeatDto
{
    /// <summary>Identifier of this heartbeat row.</summary>
    public required Guid Id { get; init; }

    /// <summary>UTC instant the server received it.</summary>
    public required DateTimeOffset ReceivedUtc { get; init; }

    /// <summary>UTC instant the agent assembled it.</summary>
    public required DateTimeOffset CollectedAtUtc { get; init; }

    /// <summary>Version of the agent that produced it.</summary>
    public string? AgentVersion { get; init; }

    /// <summary>Time elapsed since the cabinet last booted.</summary>
    public TimeSpan? Uptime { get; init; }

    /// <summary>Total CPU utilisation across all cores, as a percentage.</summary>
    public double? CpuPercent { get; init; }

    /// <summary>Physical memory in use, as a percentage.</summary>
    public double? RamUsedPercent { get; init; }

    /// <summary>Free space on the tightest volume, as a percentage.</summary>
    public double? MinFreeDiskPercent { get; init; }

    /// <summary>Worst drive health across the cabinet's disks.</summary>
    public required DiskHealthStatus WorstDiskHealth { get; init; }

    /// <summary>
    /// Whether anyone was signed in. <see langword="null"/> means the agent
    /// could not tell, and is treated as unsafe to reboot.
    /// </summary>
    public bool? AnyUserLoggedOn { get; init; }

    /// <summary>Updates detected and not installed, or null if the scan did not complete.</summary>
    public int? PendingUpdateCount { get; init; }

    /// <summary>Whether a reboot is pending to finish an installation.</summary>
    public bool? RebootPending { get; init; }

    /// <summary>
    /// Difference between the cabinet's own clock and the server's when this
    /// sample arrived.
    /// </summary>
    public TimeSpan? ClockDrift { get; init; }

    /// <summary>
    /// Collectors that could not complete, and why. A partial sample explains
    /// its own gaps rather than presenting them as absent data.
    /// </summary>
    public IReadOnlyDictionary<string, string> SectionErrors { get; init; }
        = new Dictionary<string, string>();

    /// <summary>
    /// True when this row is an hourly roll-up of heartbeats older than the
    /// full-resolution window, rather than a single sample.
    /// </summary>
    public required bool IsAggregated { get; init; }
}

/// <summary>
/// One stored version of a cabinet's inventory: what was installed, running and
/// configured at the moment it last changed.
/// </summary>
/// <remarks>
/// Inventory is stored as a change history, not as a snapshot per check-in. The
/// agent sends it every six hours and on change; the server hashes the content
/// and stores nothing when the hash matches the version already in force. A
/// cabinet nobody touches for a year holds one inventory row, not fourteen
/// hundred.
/// </remarks>
public sealed record InventoryVersionDto
{
    /// <summary>Identifier of this inventory version.</summary>
    public required Guid Id { get; init; }

    /// <summary>UTC instant this version was first observed.</summary>
    public required DateTimeOffset FirstObservedUtc { get; init; }

    /// <summary>UTC instant it was last confirmed still in force.</summary>
    public required DateTimeOffset LastObservedUtc { get; init; }

    /// <summary>
    /// Hash of the inventory content. Two versions with the same hash are the
    /// same inventory; it is what makes an unchanged check-in write nothing.
    /// </summary>
    public required string ContentHash { get; init; }

    /// <summary>Operating system and identity facts, or null if the section failed.</summary>
    public SystemInfo? System { get; init; }

    /// <summary>Windows services observed, or null if the section failed.</summary>
    public IReadOnlyList<ServiceInfo>? Services { get; init; }

    /// <summary>Adapters, firewall profiles and reachability, or null if the section failed.</summary>
    public NetworkInfo? Network { get; init; }

    /// <summary>Windows Update state and policy, or null if the section failed.</summary>
    public WindowsUpdateInfo? WindowsUpdate { get; init; }

    /// <summary>Volumes and their encryption state, or null if the section failed.</summary>
    public IReadOnlyList<DiskInfo>? Disks { get; init; }

    /// <summary>
    /// Physical memory installed, in bytes, or <see langword="null"/> if it
    /// could not be read.
    /// </summary>
    /// <remarks>
    /// Installed memory is configuration, not a counter: it changes when
    /// somebody opens the machine, so it rides the inventory tier rather than
    /// every heartbeat. Null rather than zero when unread — a cabinet with no
    /// memory is not a thing, and showing it as one would suggest the reading
    /// is real.
    /// </remarks>
    public long? InstalledMemoryBytes { get; init; }

    /// <summary>
    /// Programs configured to launch at logon or boot, or null if they could
    /// not be enumerated.
    /// </summary>
    /// <remarks>
    /// Inbound observation only. The command each entry carries is the string
    /// Windows already holds; it is shown so a rep can read what a machine
    /// launches, and is never executed or accepted back as input.
    /// </remarks>
    public IReadOnlyList<StartupProgramInfo>? StartupPrograms { get; init; }

    /// <summary>Collectors that could not complete, and why.</summary>
    public IReadOnlyDictionary<string, string> SectionErrors { get; init; }
        = new Dictionary<string, string>();
}

/// <summary>
/// One drive's SMART counters at one point in time.
/// </summary>
/// <remarks>
/// This tier is always stored and never skipped, even when nothing changed:
/// it is the failure-prediction time series this system exists to produce, and
/// a gap in it is a gap in the trend.
/// </remarks>
public sealed record SmartReadingDto
{
    /// <summary>Identifier of this reading.</summary>
    public required Guid Id { get; init; }

    /// <summary>
    /// Stable per-drive identity, the key for trending one drive over time.
    /// </summary>
    public required string DriveSerial { get; init; }

    /// <summary>Drive model string.</summary>
    public string? DriveModel { get; init; }

    /// <summary>UTC instant the reading was taken on the cabinet.</summary>
    public required DateTimeOffset TimestampUtc { get; init; }

    /// <summary>Health derived from the counters below.</summary>
    public required DiskHealthStatus Health { get; init; }

    /// <summary>
    /// Which WMI source these counters came from. A later trend query can tell
    /// structured counters apart from decoded vendor bytes, which do not mean
    /// the same thing even when they carry the same name.
    /// </summary>
    public required SmartSource Source { get; init; }

    /// <summary>The counters themselves, every one nullable.</summary>
    public required SmartInfo Smart { get; init; }

    /// <summary>
    /// True when this row is a daily roll-up of readings older than the
    /// full-resolution window, holding that day's worst observed value for each
    /// counter.
    /// </summary>
    public required bool IsAggregated { get; init; }
}

/// <summary>Filter over a cabinet's SMART history.</summary>
public sealed record SmartHistoryQuery : HistoryQuery
{
    /// <summary>Restrict to one drive.</summary>
    public string? DriveSerial { get; init; }
}

/// <summary>Filter over a cabinet's inventory change history.</summary>
public sealed record InventoryHistoryQuery : HistoryQuery;
