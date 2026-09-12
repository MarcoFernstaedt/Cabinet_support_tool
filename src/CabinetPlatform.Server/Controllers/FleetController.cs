using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Controllers;

/// <summary>The fleet dashboard: counts across everything, and the site list.</summary>
[Route("api/fleet")]
public sealed class FleetController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly ICabinetProjection _projection;
    private readonly AgentIngestOptions _ingestOptions;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the controller.</summary>
    /// <param name="db">The database.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="projection">Builds cabinet read models.</param>
    /// <param name="ingestOptions">Supplies the offline threshold.</param>
    /// <param name="timeProvider">Clock.</param>
    public FleetController(
        SupportDbContext db,
        IAuditService audit,
        ICabinetProjection projection,
        IOptions<AgentIngestOptions> ingestOptions,
        TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _projection = projection;
        _ingestOptions = ingestOptions.Value;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// Health counts across the fleet, or one client or site.
    /// </summary>
    /// <remarks>
    /// Reads one narrow row per cabinet — the projected columns of its newest
    /// heartbeat and nothing else — and folds them into counts in memory. No
    /// document is deserialised, and the query is bounded by the filter rather
    /// than by paging, because a count of everything is the point.
    /// </remarks>
    /// <param name="query">Optional client and site filter.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("health")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(FleetHealthSummary), StatusCodes.Status200OK)]
    public async Task<ActionResult<FleetHealthSummary>> Health(
        [FromQuery] FleetHealthQuery query, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        IQueryable<Domain.Cabinet> cabinets = FilterCabinets(
            query.ClientName, query.SiteName, query.SiteId, query.DepartmentName);

        // Clamped rather than refused: unlike a history window, an over-wide
        // stale window costs nothing to serve and the honest answer to "which
        // cabinets have we not heard from in ten years" is the whole fleet.
        int staleAfterHours = Math.Clamp(
            query.StaleAfterHours ?? _ingestOptions.StaleAfterHours,
            1,
            _ingestOptions.MaxStaleAfterHours);

        DateTimeOffset staleBefore = nowUtc.AddHours(-staleAfterHours);

        // Every column here is an extracted one. Nothing on this path opens a
        // stored inventory or check-in document: the aggregate runs across the
        // whole filtered fleet, and a query that deserialised seven thousand
        // payloads to count them would be a timeout on a support call rather
        // than a dashboard.
        var rows = await cabinets
            .Select(c => new
            {
                c.Id,
                c.SiteId,
                c.IsActive,
                c.LastCheckInUtc,
                c.AgentVersion,
                c.PendingSecurityUpdateCount,
                c.AutoStartServicesStoppedCount,
                IsSyncCabinet = c.Site!.SyncCabinetId == c.Id,
                Latest = _db.Heartbeats
                    .Where(h => h.CabinetId == c.Id)
                    .OrderByDescending(h => h.ReceivedUtc)
                    .Select(h => new
                    {
                        h.CpuPercent,
                        h.RamUsedPercent,
                        h.MinFreeDiskPercent,
                        h.PendingUpdateCount,
                        h.RebootPending,
                        h.WorstDiskHealth,
                        h.ClockDriftSeconds,
                    })
                    .FirstOrDefault(),
            })
            .ToListAsync(ct);

        var healthy = 0;
        var warning = 0;
        var critical = 0;
        var offline = 0;
        var unknown = 0;
        var sitesWithOfflineSync = 0;
        var stale = 0;
        var withPendingUpdates = 0;
        var withSecurityUpdates = 0;
        var rebootPending = 0;
        var autoStartStopped = 0;
        var disksHealthy = 0;
        var disksWatch = 0;
        var disksFailing = 0;
        var disksUnknown = 0;

        foreach (var row in rows)
        {
            if (row.LastCheckInUtc is null || row.LastCheckInUtc < staleBefore)
            {
                stale++;
            }

            if (row.Latest?.PendingUpdateCount > 0)
            {
                withPendingUpdates++;
            }

            if (row.PendingSecurityUpdateCount > 0)
            {
                withSecurityUpdates++;
            }

            if (row.Latest?.RebootPending == true)
            {
                rebootPending++;
            }

            if (row.AutoStartServicesStoppedCount > 0)
            {
                autoStartStopped++;
            }

            switch (row.Latest?.WorstDiskHealth ?? DiskHealthStatus.Unknown)
            {
                case DiskHealthStatus.Healthy: disksHealthy++; break;
                case DiskHealthStatus.Watch: disksWatch++; break;
                case DiskHealthStatus.Failing: disksFailing++; break;
                default: disksUnknown++; break;
            }

            CabinetHealthStatus health = HealthEvaluator.Evaluate(
                row.IsActive,
                row.LastCheckInUtc,
                nowUtc,
                _ingestOptions.OfflineAfterMinutes,
                row.Latest?.CpuPercent,
                row.Latest?.RamUsedPercent,
                row.Latest?.MinFreeDiskPercent,
                row.Latest?.PendingUpdateCount,
                row.Latest?.WorstDiskHealth,
                row.Latest?.ClockDriftSeconds is { } drift ? TimeSpan.FromSeconds(drift) : null);

            switch (health)
            {
                case CabinetHealthStatus.Healthy: healthy++; break;
                case CabinetHealthStatus.Warning: warning++; break;
                case CabinetHealthStatus.Critical: critical++; break;
                case CabinetHealthStatus.Offline: offline++; break;
                default: unknown++; break;
            }

            // Counted separately because it is the number a rep acts on first:
            // a site whose sync cabinet is down usually explains every other
            // complaint from that site.
            if (row.IsSyncCabinet && health == CabinetHealthStatus.Offline)
            {
                sitesWithOfflineSync++;
            }
        }

        // Highest count first: the number that matters is which version most of
        // the fleet is on, and how far behind the tail is.
        List<AgentVersionCount> agentVersions = rows
            .GroupBy(r => string.IsNullOrWhiteSpace(r.AgentVersion) ? null : r.AgentVersion)
            .Select(g => new AgentVersionCount { Version = g.Key, CabinetCount = g.Count() })
            .OrderByDescending(v => v.CabinetCount)
            .ThenBy(v => v.Version, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var summary = new FleetHealthSummary
        {
            TotalCabinets = rows.Count,
            Stale = stale,
            StaleAfterHours = staleAfterHours,
            WithPendingUpdates = withPendingUpdates,
            WithPendingSecurityUpdates = withSecurityUpdates,
            RebootPending = rebootPending,
            WithAutoStartServicesStopped = autoStartStopped,
            Disks = new DiskHealthCounts
            {
                Healthy = disksHealthy,
                Watch = disksWatch,
                Failing = disksFailing,
                Unknown = disksUnknown,
            },
            AgentVersions = agentVersions,
            Healthy = healthy,
            Warning = warning,
            Critical = critical,
            Offline = offline,
            Unknown = unknown,
            Inactive = rows.Count(r => !r.IsActive),
            SitesWithOfflineSyncCabinet = sitesWithOfflineSync,
            PendingRegistrations = await _db.PendingRegistrations
                .AsNoTracking()
                .CountAsync(r => r.Status == RegistrationStatus.Pending, ct),
            ActionsAwaitingApproval = await _db.ActionRequests
                .AsNoTracking()
                .CountAsync(a => a.Status == ActionRequestStatus.PendingApproval, ct),
            GeneratedUtc = nowUtc,
        };

        CurrentUser actor = CurrentUser;

        await _audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ViewFleetHealth,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = new
            {
                query.ClientName,
                query.SiteName,
                query.SiteId,
                query.DepartmentName,
                summary.TotalCabinets,
                summary.Stale,
                StaleAfterHours = staleAfterHours,
            },
        }, ct);

        return Ok(summary);
    }

    /// <summary>
    /// The site list, worst sites first.
    /// </summary>
    /// <remarks>
    /// Fleet views group by site because that is the unit a rep diagnoses. The
    /// sync cabinet's own health rides on each row, so the common cause of a
    /// whole site misbehaving is visible before anyone opens the site.
    /// </remarks>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("sites")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<SiteSummary>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<SiteSummary>>> Sites(
        [FromQuery] SiteQuery query, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        IQueryable<Domain.Site> sites = _db.Sites.AsNoTracking().Include(s => s.Client);

        if (!string.IsNullOrWhiteSpace(query.ClientName))
        {
            string client = query.ClientName.Trim();
            sites = sites.Where(s => s.Client!.Name == client);
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            string term = query.Search.Trim();
            sites = sites.Where(s =>
                EF.Functions.Like(s.Name, $"%{term}%") ||
                EF.Functions.Like(s.Client!.Name, $"%{term}%"));
        }

        int total = await sites.CountAsync(ct);

        List<Domain.Site> page = await sites
            .OrderBy(s => s.Client!.Name)
            .ThenBy(s => s.Name)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .ToListAsync(ct);

        List<Guid> siteIds = page.Select(s => s.Id).ToList();

        // One projection pass over the page's cabinets, not one per site.
        List<CabinetSummary> members = await _projection.ProjectAsync(
            _db.Cabinets.AsNoTracking().Where(c => siteIds.Contains(c.SiteId)), nowUtc, ct);

        ILookup<Guid, CabinetSummary> bySite = members.ToLookup(c => c.SiteId);

        Dictionary<Guid, SyncReachabilitySummary> reachability =
            await ReachabilityBySiteAsync(page, bySite, ct);

        List<SiteSummary> items = page
            .Select(site => Summarise(
                site, bySite[site.Id].ToList(), reachability.GetValueOrDefault(site.Id)))
            .OrderByDescending(s => Severity(s.WorstHealth))
            .ThenBy(s => s.ClientName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(s => s.SiteName, StringComparer.OrdinalIgnoreCase)
            .ToList();

        CurrentUser actor = CurrentUser;

        await _audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ListSites,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = new { query.ClientName, query.Search, ResultCount = items.Count },
        }, ct);

        return Ok(PagedResult<SiteSummary>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// One site with its cabinets, the sync cabinet first.
    /// </summary>
    /// <param name="id">The site.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("sites/{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(SiteDetailDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<SiteDetailDto>> Site(Guid id, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        Domain.Site? site = await _db.Sites.AsNoTracking()
            .Include(s => s.Client)
            .FirstOrDefaultAsync(s => s.Id == id, ct);

        if (site is null)
        {
            await _audit.WriteDenialAsync(AuditEvent.ListSites, "Site not found.", null,
                new { SiteId = id }, null, ct);
            return Problem("Site not found.", statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        List<CabinetSummary> members = await _projection.ProjectAsync(
            _db.Cabinets.AsNoTracking().Where(c => c.SiteId == id), nowUtc, ct);

        // The sync cabinet leads, then departments, then name. A rep opening a
        // site that is misbehaving as a whole is nearly always looking for the
        // sync cabinet, and should not have to find it among twenty rows.
        List<CabinetSummary> ordered = members
            .OrderBy(c => c.Id == site.SyncCabinetId ? 0 : 1)
            .ThenBy(c => c.DepartmentName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(c => c.Hostname, StringComparer.OrdinalIgnoreCase)
            .ToList();

        List<Domain.CabinetLinkProbe> probes = site.SyncCabinetId is { } syncId
            ? await _db.CabinetLinkProbes.AsNoTracking()
                .Where(p => p.TargetCabinetId == syncId)
                .ToListAsync(ct)
            : new List<Domain.CabinetLinkProbe>();

        CurrentUser actor = CurrentUser;

        await _audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ListSites,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = new { SiteId = id, CabinetCount = members.Count },
        }, ct);

        Dictionary<Guid, Domain.CabinetLinkProbe> probeBySource =
            probes.ToDictionary(p => p.SourceCabinetId);

        return Ok(new SiteDetailDto
        {
            Site = Summarise(site, ordered, SummariseReachability(site, ordered, probes)),
            Cabinets = ordered,
            // The paths ride alongside, so no console has to assemble an
            // identification of its own and a hostname repeated within the site
            // is flagged rather than left to be noticed.
            CabinetPaths = CabinetPath.MarkAmbiguity(
                ordered.Select(c => CabinetPath.From(c)).ToList()),
            SatelliteLinks = ordered
                .Where(c => c.Id != site.SyncCabinetId)
                .Select(c =>
                {
                    Domain.CabinetLinkProbe? probe = probeBySource.GetValueOrDefault(c.Id);

                    return new SatelliteLinkDto
                    {
                        CabinetId = c.Id,
                        // Null until somebody actually probes. Reachable from
                        // the server is a different fact and is never presented
                        // as this one.
                        Reachable = probe?.Reachable,
                        ObservedUtc = probe?.ObservedUtc,
                        LatencyMs = probe?.LatencyMs,
                    };
                })
                .ToList(),
        });
    }

    /// <summary>
    /// Reads every satellite's last probe of its site's sync cabinet, for one
    /// page of sites.
    /// </summary>
    /// <remarks>
    /// One query for the page rather than one per site. The probe table holds a
    /// single row per ordered pair, so this is bounded by the number of
    /// cabinets at the sites on screen.
    /// </remarks>
    private async Task<Dictionary<Guid, SyncReachabilitySummary>> ReachabilityBySiteAsync(
        IReadOnlyList<Domain.Site> sites,
        ILookup<Guid, CabinetSummary> bySite,
        CancellationToken ct)
    {
        List<Guid> syncIds = sites
            .Where(s => s.SyncCabinetId is not null)
            .Select(s => s.SyncCabinetId!.Value)
            .ToList();

        if (syncIds.Count == 0)
        {
            return new Dictionary<Guid, SyncReachabilitySummary>();
        }

        List<Domain.CabinetLinkProbe> probes = await _db.CabinetLinkProbes.AsNoTracking()
            .Where(p => syncIds.Contains(p.TargetCabinetId))
            .ToListAsync(ct);

        var result = new Dictionary<Guid, SyncReachabilitySummary>();

        foreach (Domain.Site site in sites)
        {
            if (site.SyncCabinetId is null)
            {
                continue;
            }

            SyncReachabilitySummary? summary =
                SummariseReachability(site, bySite[site.Id].ToList(), probes);

            if (summary is not null)
            {
                result[site.Id] = summary;
            }
        }

        return result;
    }

    /// <summary>
    /// Counts how a site's satellites last found the cabinet that syncs it.
    /// </summary>
    /// <remarks>
    /// Null for a standalone site, which has no such relationship to report and
    /// must not be shown an empty one. Satellites that have never probed are
    /// counted separately and never folded into either of the others: not
    /// knowing is not the same as reaching, and it is not the same as failing.
    /// </remarks>
    private static SyncReachabilitySummary? SummariseReachability(
        Domain.Site site,
        IReadOnlyList<CabinetSummary> members,
        IReadOnlyList<Domain.CabinetLinkProbe> probes)
    {
        if (site.SyncCabinetId is not { } syncId)
        {
            return null;
        }

        Dictionary<Guid, Domain.CabinetLinkProbe> bySource = probes
            .Where(p => p.TargetCabinetId == syncId)
            .GroupBy(p => p.SourceCabinetId)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(p => p.ObservedUtc).First());

        var reaching = 0;
        var notReaching = 0;
        var neverProbed = 0;
        DateTimeOffset? mostRecent = null;

        foreach (CabinetSummary member in members)
        {
            if (member.Id == syncId)
            {
                continue;
            }

            if (!bySource.TryGetValue(member.Id, out Domain.CabinetLinkProbe? probe))
            {
                neverProbed++;
                continue;
            }

            if (probe.Reachable)
            {
                reaching++;
            }
            else
            {
                notReaching++;
            }

            if (mostRecent is null || probe.ObservedUtc > mostRecent)
            {
                mostRecent = probe.ObservedUtc;
            }
        }

        return new SyncReachabilitySummary
        {
            Reaching = reaching,
            NotReaching = notReaching,
            NeverProbed = neverProbed,
            MostRecentProbeUtc = mostRecent,
        };
    }

    private IQueryable<Domain.Cabinet> FilterCabinets(
        string? clientName, string? siteName, Guid? siteId, string? departmentName)
    {
        IQueryable<Domain.Cabinet> cabinets = _db.Cabinets.AsNoTracking();

        if (!string.IsNullOrWhiteSpace(clientName))
        {
            string client = clientName.Trim();
            cabinets = cabinets.Where(c => c.Site!.Client!.Name == client);
        }

        if (!string.IsNullOrWhiteSpace(siteName))
        {
            string site = siteName.Trim();
            cabinets = cabinets.Where(c => c.Site!.Name == site);
        }

        // By identifier as well as by name, because two clients can and do use
        // the same site name and a rep drilling in from a client has an id.
        if (siteId is { } id)
        {
            cabinets = cabinets.Where(c => c.SiteId == id);
        }

        if (!string.IsNullOrWhiteSpace(departmentName))
        {
            string department = departmentName.Trim();
            cabinets = cabinets.Where(c => c.DepartmentName == department);
        }

        return cabinets;
    }

    private static SiteSummary Summarise(
        Domain.Site site,
        IReadOnlyList<CabinetSummary> members,
        SyncReachabilitySummary? syncReachability)
    {
        CabinetSummary? sync = members.FirstOrDefault(c => c.Id == site.SyncCabinetId);

        return new SiteSummary
        {
            SyncReachability = syncReachability,
            Id = site.Id,
            ClientName = site.Client!.Name,
            SiteName = site.Name,
            SyncCabinetId = site.SyncCabinetId,
            SyncCabinetHostname = sync?.Hostname,
            SyncCabinetHealth = sync?.Health,
            CabinetCount = members.Count,
            UnhealthyCabinetCount = members.Count(c => c.Health != CabinetHealthStatus.Healthy),
            WorstHealth = members.Count == 0
                ? CabinetHealthStatus.Unknown
                : members.Aggregate(
                    CabinetHealthStatus.Healthy, (worst, c) => HealthEvaluator.Worse(worst, c.Health)),
        };
    }

    private static int Severity(CabinetHealthStatus status) => status switch
    {
        CabinetHealthStatus.Healthy => 0,
        CabinetHealthStatus.Unknown => 1,
        CabinetHealthStatus.Warning => 2,
        CabinetHealthStatus.Offline => 3,
        CabinetHealthStatus.Critical => 4,
        _ => 1,
    };
}
