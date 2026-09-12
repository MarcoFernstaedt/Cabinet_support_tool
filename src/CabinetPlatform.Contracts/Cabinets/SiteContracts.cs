using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>
/// A client site and the cabinet that syncs it.
/// </summary>
/// <remarks>
/// The hierarchy is client to site to cabinet, and both extremes in the real
/// fleet are ordinary: a single-site client with one cabinet, and a multi-site
/// client with many cabinets per site. Nothing here assumes either.
/// </remarks>
public sealed record SiteSummary
{
    /// <summary>Identifier of the site.</summary>
    public required Guid Id { get; init; }

    /// <summary>Client this site belongs to.</summary>
    public required string ClientName { get; init; }

    /// <summary>Name of the site within that client.</summary>
    public required string SiteName { get; init; }

    /// <summary>
    /// The one cabinet that holds this site's data, or <see langword="null"/>
    /// for a standalone site. A site never has more than one.
    /// </summary>
    public Guid? SyncCabinetId { get; init; }

    /// <summary>Hostname of that sync cabinet.</summary>
    public string? SyncCabinetHostname { get; init; }

    /// <summary>Rolled-up health of that sync cabinet.</summary>
    public CabinetHealthStatus? SyncCabinetHealth { get; init; }

    /// <summary>How many cabinets sit at this site.</summary>
    public required int CabinetCount { get; init; }

    /// <summary>How many of them are not healthy.</summary>
    public required int UnhealthyCabinetCount { get; init; }

    /// <summary>Worst health across the site, for ordering the fleet view.</summary>
    public required CabinetHealthStatus WorstHealth { get; init; }

    /// <summary>
    /// How the site's satellites last found their sync cabinet.
    /// </summary>
    /// <remarks>
    /// Carried on the site row rather than left for a rep to open each cabinet
    /// and find, because a sync cabinet problem does not present as a sync
    /// cabinet problem: it presents as every cabinet at the site behaving
    /// oddly. Null for a standalone site, which has no such relationship to
    /// report and must not be shown an empty one.
    /// </remarks>
    public SyncReachabilitySummary? SyncReachability { get; init; }
}

/// <summary>
/// How many of a site's satellites could last reach the cabinet that syncs it.
/// </summary>
/// <remarks>
/// Reachable from the server is a different fact and is never substituted for
/// this one. A sync cabinet can be perfectly healthy from the support desk's
/// point of view while a switch inside the clinic stops its satellites talking
/// to it, and that is precisely the fault this exists to surface.
/// </remarks>
public sealed record SyncReachabilitySummary
{
    /// <summary>Satellites whose most recent probe reached the sync cabinet.</summary>
    public required int Reaching { get; init; }

    /// <summary>Satellites whose most recent probe did not reach it.</summary>
    public required int NotReaching { get; init; }

    /// <summary>
    /// Satellites that have never probed it. Counted separately and never
    /// folded into either of the others: not knowing is not the same as
    /// reaching, and it is not the same as failing.
    /// </summary>
    public required int NeverProbed { get; init; }

    /// <summary>UTC instant of the most recent probe at this site, when there has been one.</summary>
    public DateTimeOffset? MostRecentProbeUtc { get; init; }
}

/// <summary>Filter over the site list.</summary>
public sealed record SiteQuery : PagedQuery
{
    /// <summary>Restrict to one client.</summary>
    public string? ClientName { get; init; }

    /// <summary>Free-text match over client and site name.</summary>
    public string? Search { get; init; }
}

/// <summary>
/// A site with its cabinets, sync cabinet first.
/// </summary>
/// <remarks>
/// The sync cabinet leads the list because it is the common cause when a whole
/// site misbehaves, and a rep should not have to find it among twenty rows.
/// </remarks>
public sealed record SiteDetailDto
{
    /// <summary>The site's own facts.</summary>
    public required SiteSummary Site { get; init; }

    /// <summary>Its cabinets, the sync cabinet first and the rest by hostname.</summary>
    public IReadOnlyList<CabinetSummary> Cabinets { get; init; } = Array.Empty<CabinetSummary>();

    /// <summary>
    /// The same cabinets as full identifying paths, in the same order.
    /// </summary>
    /// <remarks>
    /// Carried alongside the summaries so that no console has to assemble an
    /// identification of its own, and so that a hostname repeated within the
    /// site is flagged here rather than left to be noticed.
    /// </remarks>
    public IReadOnlyList<CabinetPath> CabinetPaths { get; init; } = Array.Empty<CabinetPath>();

    /// <summary>
    /// Each satellite's last probe of the sync cabinet, keyed by cabinet id.
    /// </summary>
    public IReadOnlyList<SatelliteLinkDto> SatelliteLinks { get; init; } = Array.Empty<SatelliteLinkDto>();
}

/// <summary>One satellite's most recent probe of its site's sync cabinet.</summary>
public sealed record SatelliteLinkDto
{
    /// <summary>The satellite.</summary>
    public required Guid CabinetId { get; init; }

    /// <summary>
    /// Whether its most recent probe reached the sync cabinet, or
    /// <see langword="null"/> when it has never probed.
    /// </summary>
    public bool? Reachable { get; init; }

    /// <summary>UTC instant of that probe.</summary>
    public DateTimeOffset? ObservedUtc { get; init; }

    /// <summary>Round-trip time it measured.</summary>
    public double? LatencyMs { get; init; }
}

/// <summary>A Supervisor changing a cabinet's part in its site's topology.</summary>
/// <remarks>
/// Promoting a cabinet to <see cref="CabinetRole.Sync"/> where the site already
/// has one is refused. Demoting the current sync cabinet, then promoting
/// another, is two audited decisions rather than one silent swap.
/// </remarks>
public sealed record SetCabinetRoleRequest
{
    /// <summary>The role to set.</summary>
    public required CabinetRole Role { get; init; }

    /// <summary>Why it is changing. Required, and audited.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the change is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}
