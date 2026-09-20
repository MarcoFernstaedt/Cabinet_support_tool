using System.Text.Json.Serialization;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>
/// The list-view shape of a cabinet.
/// </summary>
/// <remarks>
/// Deliberately flat and payload-free: the server projects straight to these
/// columns so a seven-thousand-cabinet page never deserialises a stored
/// check-in payload. Every telemetry field is nullable, because a cabinet that
/// has never checked in has no readings and must not be rendered as an idle
/// one.
/// </remarks>
public sealed record CabinetSummary
{
    /// <summary>Supervisor-chosen label, independent of device identity.</summary>
    public string? FriendlyName { get; init; }
    /// <summary>Friendly label, falling back to the reported hostname.</summary>
    public string DisplayName => string.IsNullOrWhiteSpace(FriendlyName) ? Hostname : FriendlyName;

    /// <summary>Identifier of the cabinet.</summary>
    public required Guid Id { get; init; }

    /// <summary>Stable hardware-derived machine identifier, hashed.</summary>
    public required string MachineId { get; init; }

    /// <summary>Current hostname. Display only; cabinets are identified by machine id.</summary>
    public required string Hostname { get; init; }

    /// <summary>Client this cabinet belongs to.</summary>
    public required string ClientName { get; init; }

    /// <summary>Site within that client.</summary>
    public required string SiteName { get; init; }

    /// <summary>Identifier of that site, for grouping without matching on names.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Department within the site, when the client uses them.</summary>
    public string? DepartmentName { get; init; }

    /// <summary>This cabinet's part in its site's topology.</summary>
    public required CabinetRole Role { get; init; }

    /// <summary>Cabinet model, when known.</summary>
    public string? Model { get; init; }

    /// <summary>Cabinet serial number, when known.</summary>
    public string? SerialNumber { get; init; }

    /// <summary>Whether the cabinet is in service.</summary>
    public required bool IsActive { get; init; }

    /// <summary>UTC instant of the most recent check-in of any tier.</summary>
    public DateTimeOffset? LastCheckInUtc { get; init; }

    /// <summary>Version of the agent that last reported.</summary>
    public string? AgentVersion { get; init; }

    /// <summary>
    /// The cabinet's own time zone, as Windows reported it. Maintenance windows
    /// and scheduled installs are evaluated in this zone, never the server's.
    /// </summary>
    public string? TimeZoneId { get; init; }

    /// <summary>Rolled-up health for the fleet view.</summary>
    public required CabinetHealthStatus Health { get; init; }

    /// <summary>Total CPU utilisation at the last heartbeat, or null if it was not read.</summary>
    public double? CpuPercent { get; init; }

    /// <summary>Memory in use at the last heartbeat, or null if it was not read.</summary>
    public double? RamUsedPercent { get; init; }

    /// <summary>Tightest volume's free space at the last heartbeat, or null if no volume was read.</summary>
    public double? MinFreeDiskPercent { get; init; }

    /// <summary>Pending updates at the last heartbeat, or null if the scan did not complete.</summary>
    public int? PendingUpdateCount { get; init; }

    /// <summary>Whether a reboot is pending to finish an installation.</summary>
    public bool? RebootPending { get; init; }

    /// <summary>Worst drive health across the cabinet's disks.</summary>
    public required DiskHealthStatus WorstDiskHealth { get; init; }

    /// <summary>
    /// Whether anyone was signed in at the last heartbeat. <see langword="null"/>
    /// means the agent could not tell, which is treated as unsafe to reboot —
    /// identically to <see langword="true"/>.
    /// </summary>
    public bool? AnyUserLoggedOn { get; init; }

    /// <summary>
    /// Difference between the cabinet's own clock and the server's at the last
    /// heartbeat. Drift breaks site synchronisation and audit ordering alike.
    /// </summary>
    public TimeSpan? ClockDrift { get; init; }
}

/// <summary>Filter over the cabinet list.</summary>
public sealed record CabinetQuery : PagedQuery
{
    /// <summary>Restrict to one client.</summary>
    public string? ClientName { get; init; }

    /// <summary>Restrict to one site by name.</summary>
    public string? SiteName { get; init; }

    /// <summary>Restrict to one site by identifier.</summary>
    public Guid? SiteId { get; init; }

    /// <summary>Free-text match over hostname, machine id, model and serial.</summary>
    public string? Search { get; init; }

    /// <summary>Restrict to in-service or withdrawn cabinets.</summary>
    public bool? IsActive { get; init; }

    /// <summary>Restrict to one rolled-up health state.</summary>
    public CabinetHealthStatus? Health { get; init; }

    /// <summary>Restrict to one topology role.</summary>
    public CabinetRole? Role { get; init; }
}

/// <summary>
/// Everything the cabinet detail view needs in one response.
/// </summary>
/// <remarks>
/// The heavy sections come from the tier that last carried them, not from one
/// check-in: a heartbeat five minutes ago and an inventory six hours ago are
/// both current, and pretending otherwise would show a rep an empty services
/// list on a healthy cabinet.
/// </remarks>
public sealed record CabinetDetailDto
{
    /// <summary>The cabinet's list-view facts.</summary>
    public required CabinetSummary Cabinet { get; init; }

    /// <summary>
    /// Its full identifying path, for the header a console keeps visible while
    /// the rest of the detail scrolls.
    /// </summary>
    /// <remarks>
    /// A rep reading a log view forty rows down has scrolled the cabinet's name
    /// off the screen. Every action they then take is on whichever cabinet they
    /// believe they are looking at, which is why the path is a first-class part
    /// of this response rather than something a console reassembles.
    /// </remarks>
    public required CabinetPath Path { get; init; }

    /// <summary>Its site, including which cabinet syncs the site.</summary>
    public required SiteSummary Site { get; init; }

    /// <summary>
    /// The site's sync cabinet as this cabinet last reached it, or
    /// <see langword="null"/> when the site has none or this cabinet is it.
    /// </summary>
    public SyncCabinetLinkDto? SyncCabinetLink { get; init; }

    /// <summary>The most recent heartbeat, or null if the cabinet has never checked in.</summary>
    public HeartbeatDto? LatestHeartbeat { get; init; }

    /// <summary>The inventory version in force, or null if none has been stored.</summary>
    public InventoryVersionDto? CurrentInventory { get; init; }

    /// <summary>The most recent SMART reading per drive.</summary>
    public IReadOnlyList<SmartReadingDto> LatestSmartReadings { get; init; }
        = Array.Empty<SmartReadingDto>();

    /// <summary>
    /// The cabinet's local time when this response was built, so the console
    /// can show it beside the rep's own.
    /// </summary>
    public DateTimeOffset? CabinetLocalTime { get; init; }
}

/// <summary>
/// How a satellite cabinet is placed relative to the cabinet its site syncs
/// against, and whether it could last reach it.
/// </summary>
public sealed record SyncCabinetLinkDto
{
    /// <summary>Identifier of the site's sync cabinet.</summary>
    public required Guid SyncCabinetId { get; init; }

    /// <summary>Its hostname.</summary>
    public required string SyncCabinetHostname { get; init; }

    /// <summary>Its rolled-up health.</summary>
    public required CabinetHealthStatus SyncCabinetHealth { get; init; }

    /// <summary>UTC instant the sync cabinet last checked in.</summary>
    public DateTimeOffset? SyncCabinetLastCheckInUtc { get; init; }

    /// <summary>
    /// Whether the most recent probe from this cabinet reached it, or
    /// <see langword="null"/> when no probe has been run. Never inferred from
    /// the sync cabinet merely being online: reachable from the server is not
    /// reachable from the satellite.
    /// </summary>
    public bool? LastProbeReachable { get; init; }

    /// <summary>UTC instant of that probe.</summary>
    public DateTimeOffset? LastProbeUtc { get; init; }

    /// <summary>Round-trip time that probe measured.</summary>
    public double? LastProbeLatencyMs { get; init; }
}

/// <summary>Rolled-up health of a cabinet, used by the fleet dashboard.</summary>
/// <remarks>
/// <see cref="Unknown"/> is the zero value on purpose: a cabinet whose state
/// could not be established must never read as <see cref="Healthy"/>.
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CabinetHealthStatus
{
    /// <summary>Health could not be assessed.</summary>
    Unknown = 0,

    /// <summary>No indicators of trouble.</summary>
    Healthy = 1,

    /// <summary>Indicators warrant monitoring but no action yet.</summary>
    Warning = 2,

    /// <summary>Needs attention now.</summary>
    Critical = 3,

    /// <summary>No check-in inside the configured stale window.</summary>
    Offline = 4,
}

/// <summary>Aggregate fleet counts for the dashboard's top row.</summary>
public sealed record FleetHealthSummary
{
    /// <summary>Cabinets matching the filter.</summary>
    public required int TotalCabinets { get; init; }

    /// <summary>How many are healthy.</summary>
    public required int Healthy { get; init; }

    /// <summary>How many warrant monitoring.</summary>
    public required int Warning { get; init; }

    /// <summary>How many need attention now.</summary>
    public required int Critical { get; init; }

    /// <summary>How many have not checked in inside the stale window.</summary>
    public required int Offline { get; init; }

    /// <summary>How many could not be assessed.</summary>
    public required int Unknown { get; init; }

    /// <summary>How many are withdrawn from service.</summary>
    public required int Inactive { get; init; }

    /// <summary>Agents waiting in the pending queue.</summary>
    public required int PendingRegistrations { get; init; }

    /// <summary>Actions waiting for a second person.</summary>
    public required int ActionsAwaitingApproval { get; init; }

    /// <summary>Sites whose sync cabinet is offline, the usual cause of a whole site misbehaving.</summary>
    public required int SitesWithOfflineSyncCabinet { get; init; }

    /// <summary>
    /// Cabinets whose last check-in is older than the stale window, which is
    /// configurable and is not the same as the offline threshold.
    /// </summary>
    /// <remarks>
    /// Offline is a health verdict and shows up as a red row. Stale is a
    /// question about the telemetry rather than the cabinet: a fleet with three
    /// hundred stale cabinets has an agent or a network problem, not three
    /// hundred broken cabinets, and the two numbers diverging is itself the
    /// signal.
    /// </remarks>
    public required int Stale { get; init; }

    /// <summary>How far back the stale count reaches, in hours.</summary>
    public required int StaleAfterHours { get; init; }

    /// <summary>Cabinets with at least one update detected and not installed.</summary>
    public required int WithPendingUpdates { get; init; }

    /// <summary>Cabinets with at least one pending update Windows classes as a security fix.</summary>
    public required int WithPendingSecurityUpdates { get; init; }

    /// <summary>Cabinets waiting on a restart to finish an installation.</summary>
    public required int RebootPending { get; init; }

    /// <summary>
    /// Cabinets with at least one automatic-start service that is stopped.
    /// </summary>
    /// <remarks>
    /// The highest-value diagnostic in the fleet: a service configured to start
    /// at boot and not running is nearly always the direct cause of whatever
    /// the client is ringing about.
    /// </remarks>
    public required int WithAutoStartServicesStopped { get; init; }

    /// <summary>Cabinets by the worst health of any drive in them.</summary>
    public required DiskHealthCounts Disks { get; init; }

    /// <summary>
    /// How many cabinets run each agent version, highest count first.
    /// </summary>
    /// <remarks>
    /// A fleet running four agent versions is a fleet where a bug report means
    /// four different things, so the distribution is a first-class number
    /// rather than something to derive from a filtered list.
    /// </remarks>
    public IReadOnlyList<AgentVersionCount> AgentVersions { get; init; } = Array.Empty<AgentVersionCount>();

    /// <summary>UTC instant the summary was computed.</summary>
    public required DateTimeOffset GeneratedUtc { get; init; }
}

/// <summary>Cabinets counted by the worst drive health reported in them.</summary>
public sealed record DiskHealthCounts
{
    /// <summary>No drive shows an indicator of trouble.</summary>
    public required int Healthy { get; init; }

    /// <summary>At least one drive warrants monitoring.</summary>
    public required int Watch { get; init; }

    /// <summary>At least one drive is failing.</summary>
    public required int Failing { get; init; }

    /// <summary>No drive health could be established.</summary>
    public required int Unknown { get; init; }
}

/// <summary>One agent version and how many cabinets run it.</summary>
public sealed record AgentVersionCount
{
    /// <summary>The version string the agent reported, or null where none has been.</summary>
    public string? Version { get; init; }

    /// <summary>How many cabinets report it.</summary>
    public required int CabinetCount { get; init; }
}

/// <summary>Filter over the fleet summary.</summary>
public sealed record FleetHealthQuery
{
    /// <summary>Restrict to one client.</summary>
    public string? ClientName { get; init; }

    /// <summary>Restrict to one site.</summary>
    public string? SiteName { get; init; }

    /// <summary>Restrict to one site by identifier.</summary>
    public Guid? SiteId { get; init; }

    /// <summary>Restrict to one department within the filtered sites.</summary>
    public string? DepartmentName { get; init; }

    /// <summary>
    /// How old a cabinet's last check-in must be to count as stale, in hours.
    /// </summary>
    /// <remarks>
    /// Configurable per request rather than fixed, because the useful window
    /// differs by what is being asked: twelve hours answers "did the overnight
    /// run reach everything", and seven days answers "which cabinets has
    /// nobody heard from since the upgrade". Clamped server-side.
    /// </remarks>
    public int? StaleAfterHours { get; init; }
}
