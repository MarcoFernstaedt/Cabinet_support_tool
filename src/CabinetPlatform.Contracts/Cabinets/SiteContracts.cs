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
