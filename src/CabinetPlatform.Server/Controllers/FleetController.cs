using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
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
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(FleetHealthSummary), StatusCodes.Status200OK)]
    public async Task<ActionResult<FleetHealthSummary>> Health(
        [FromQuery] FleetHealthQuery query, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        IQueryable<Domain.Cabinet> cabinets = FilterCabinets(query.ClientName, query.SiteName);

        var rows = await cabinets
            .Select(c => new
            {
                c.Id,
                c.SiteId,
                c.IsActive,
                c.LastCheckInUtc,
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

        foreach (var row in rows)
        {
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

        var summary = new FleetHealthSummary
        {
            TotalCabinets = rows.Count,
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
            Details = new { query.ClientName, query.SiteName, summary.TotalCabinets },
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
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
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

        List<SiteSummary> items = page
            .Select(site => Summarise(site, bySite[site.Id].ToList()))
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
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
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

        return Ok(new SiteDetailDto
        {
            Site = Summarise(site, members),
            Cabinets = members
                .OrderBy(c => c.Id == site.SyncCabinetId ? 0 : 1)
                .ThenBy(c => c.Hostname, StringComparer.OrdinalIgnoreCase)
                .ToList(),
        });
    }

    private IQueryable<Domain.Cabinet> FilterCabinets(string? clientName, string? siteName)
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

        return cabinets;
    }

    private static SiteSummary Summarise(Domain.Site site, IReadOnlyList<CabinetSummary> members)
    {
        CabinetSummary? sync = members.FirstOrDefault(c => c.Id == site.SyncCabinetId);

        return new SiteSummary
        {
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
