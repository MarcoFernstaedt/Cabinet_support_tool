using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
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

/// <summary>Reading the fleet: cabinets, their telemetry and their topology.</summary>
[Route("api/cabinets")]
public sealed class CabinetsController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly ICabinetProjection _projection;
    private readonly ICabinetClock _clock;
    private readonly ICabinetSearchService _search;
    private readonly QueryLimitsOptions _queryLimits;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the controller.</summary>
    /// <param name="db">The database.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="projection">Builds cabinet read models.</param>
    /// <param name="clock">Resolves cabinet-local time.</param>
    /// <param name="search">Records which cabinets this rep has opened.</param>
    /// <param name="queryLimits">History query bounds.</param>
    /// <param name="timeProvider">Clock.</param>
    public CabinetsController(
        SupportDbContext db,
        IAuditService audit,
        ICabinetProjection projection,
        ICabinetClock clock,
        ICabinetSearchService search,
        IOptions<QueryLimitsOptions> queryLimits,
        TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _projection = projection;
        _clock = clock;
        _search = search;
        _queryLimits = queryLimits.Value;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// The fleet grid.
    /// </summary>
    /// <remarks>
    /// Projects straight to the extracted columns and joins to the newest
    /// heartbeat per cabinet — no stored document is touched, because
    /// deserialising seven thousand of them to draw a list would fall over.
    /// </remarks>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<CabinetSummary>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<CabinetSummary>>> List(
        [FromQuery] CabinetQuery query, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        IQueryable<Domain.Cabinet> cabinets = _db.Cabinets.AsNoTracking();

        if (!string.IsNullOrWhiteSpace(query.ClientName))
        {
            string client = query.ClientName.Trim();
            cabinets = cabinets.Where(c => c.Site!.Client!.Name == client);
        }

        if (!string.IsNullOrWhiteSpace(query.SiteName))
        {
            string site = query.SiteName.Trim();
            cabinets = cabinets.Where(c => c.Site!.Name == site);
        }

        if (query.SiteId is { } siteId)
        {
            cabinets = cabinets.Where(c => c.SiteId == siteId);
        }

        if (query.IsActive is { } isActive)
        {
            cabinets = cabinets.Where(c => c.IsActive == isActive);
        }

        if (query.Role is { } role)
        {
            cabinets = cabinets.Where(c => c.Role == role);
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            string term = query.Search.Trim();
            cabinets = cabinets.Where(c =>
                EF.Functions.Like(c.Hostname, $"%{term}%") ||
                EF.Functions.Like(c.FriendlyName ?? string.Empty, $"%{term}%") ||
                EF.Functions.Like(c.MachineId, $"%{term}%") ||
                EF.Functions.Like(c.Site!.Client!.Name, $"%{term}%") ||
                EF.Functions.Like(c.Site!.Name, $"%{term}%"));
        }

        if (query.Health is { } health)
        {
            cabinets = _projection.FilterByHealth(cabinets, health, nowUtc);
        }

        int total = await cabinets.CountAsync(ct);

        // Sync cabinets lead their site: when a whole site misbehaves, the
        // sync cabinet is the common cause and a rep should not have to hunt
        // for it among twenty rows.
        IQueryable<Domain.Cabinet> page = cabinets
            .OrderBy(c => c.Site!.Client!.Name)
            .ThenBy(c => c.Site!.Name)
            .ThenBy(c => c.Role == Contracts.Cabinets.CabinetRole.Sync ? 0 : 1)
            .ThenBy(c => c.Hostname)
            .ThenBy(c => c.Id)
            .Skip(query.Skip)
            .Take(query.PageSize);

        List<CabinetSummary> items = await _projection.ProjectAsync(page, nowUtc, ct);

        await _audit.WriteAsync(Observed(AuditEvent.ListCabinets, new
        {
            query.ClientName,
            query.SiteName,
            query.Page,
            query.PageSize,
            ResultCount = items.Count,
        }), ct);

        return Ok(PagedResult<CabinetSummary>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// Everything the cabinet detail view needs: the cabinet, its site, its
    /// link to its sync cabinet, and the newest of each telemetry tier.
    /// </summary>
    /// <param name="id">The cabinet.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(CabinetDetailDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CabinetDetailDto>> Detail(Guid id, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        Domain.Cabinet? cabinet = await _db.Cabinets
            .AsNoTracking()
            .Include(c => c.Site)
            .ThenInclude(s => s!.Client)
            .FirstOrDefaultAsync(c => c.Id == id, ct);

        if (cabinet?.Site is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewCabinetLatest, "Cabinet not found.", id, null, null, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        CabinetSummary summary =
            (await _projection.ProjectAsync(
                _db.Cabinets.AsNoTracking().Where(c => c.Id == id), nowUtc, ct)).Single();

        Domain.Heartbeat? heartbeat = await _db.Heartbeats.AsNoTracking()
            .Where(h => h.CabinetId == id)
            .OrderByDescending(h => h.CollectedAtUtc)
            .FirstOrDefaultAsync(ct);

        Domain.InventoryVersion? inventory = cabinet.CurrentInventoryVersionId is { } inventoryId
            ? await _db.InventoryVersions.AsNoTracking().FirstOrDefaultAsync(v => v.Id == inventoryId, ct)
            : null;

        List<SmartReadingDto> smart = await NewestSmartPerDriveAsync(id, ct);
        SiteSummary site = await ProjectSiteAsync(cabinet.SiteId, nowUtc, ct);
        SyncCabinetLinkDto? link = await ProjectSyncLinkAsync(cabinet, site, nowUtc, ct);

        var dto = new CabinetDetailDto
        {
            Cabinet = summary,
            // The path a console pins to its header so a rep deep in a log view
            // can always see whose cabinet they are reading. Ambiguity is not
            // marked here: a single cabinet is not a result set, and there is
            // nothing for its name to collide with.
            Path = CabinetPath.From(summary),
            Site = site,
            SyncCabinetLink = link,
            LatestHeartbeat = heartbeat is null ? null : ToDto(heartbeat),
            CurrentInventory = inventory is null ? null : ToDto(inventory),
            LatestSmartReadings = smart,
            CabinetLocalTime = _clock.ToCabinetLocal(cabinet, nowUtc),
        };

        await _audit.WriteAsync(Observed(AuditEvent.ViewCabinetLatest, new { CabinetId = id }, id), ct);

        // Opening a cabinet puts it at the top of this rep's recent list. It
        // rides the same save as the audit write, so it costs no extra round
        // trip on the hottest read in the console.
        await _search.RecordViewAsync(CurrentUser.UserId, id, nowUtc, ct);
        await _db.SaveChangesAsync(ct);

        return Ok(dto);
    }

    /// <summary>One cabinet's heartbeat history, paged and bounded.</summary>
    /// <param name="id">The cabinet.</param>
    /// <param name="query">Window and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("{id:guid}/heartbeats")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<HeartbeatDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PagedResult<HeartbeatDto>>> Heartbeats(
        Guid id, [FromQuery] HistoryQuery query, CancellationToken ct)
    {
        if (!await _db.Cabinets.AsNoTracking().AnyAsync(c => c.Id == id, ct))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewCabinetHistory, "Cabinet not found.", id, null, null, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        OperationResult<(DateTimeOffset From, DateTimeOffset To)> window = ResolveWindow(query);

        if (!window.Succeeded)
        {
            // A refused request is still a request. Silently 400-ing a range
            // that policy would not serve leaves no trace that somebody asked
            // for three years of one cabinet's history.
            await _audit.WriteDenialAsync(
                AuditEvent.ViewCabinetHistory, window.Reason!, id,
                new { query.FromUtc, query.ToUtc }, null, ct);

            return Problem(window);
        }

        IQueryable<Domain.Heartbeat> rows = _db.Heartbeats.AsNoTracking()
            .Where(h => h.CabinetId == id &&
                        h.ReceivedUtc >= window.Value.From &&
                        h.ReceivedUtc < window.Value.To);

        int total = await rows.CountAsync(ct);

        List<HeartbeatDto> items = (await rows
                .OrderByDescending(h => h.ReceivedUtc)
                .Skip(query.Skip)
                .Take(query.PageSize)
                .ToListAsync(ct))
            .Select(ToDto)
            .ToList();

        await _audit.WriteAsync(Observed(AuditEvent.ViewCabinetHistory, new
        {
            CabinetId = id,
            window.Value.From,
            window.Value.To,
            ResultCount = items.Count,
        }, id), ct);

        return Ok(PagedResult<HeartbeatDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>One cabinet's inventory change history.</summary>
    /// <param name="id">The cabinet.</param>
    /// <param name="query">Window and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("{id:guid}/inventory")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<InventoryVersionDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PagedResult<InventoryVersionDto>>> Inventory(
        Guid id, [FromQuery] InventoryHistoryQuery query, CancellationToken ct)
    {
        if (!await _db.Cabinets.AsNoTracking().AnyAsync(c => c.Id == id, ct))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewCabinetInventory, "Cabinet not found.", id, null, null, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        IQueryable<Domain.InventoryVersion> rows = _db.InventoryVersions.AsNoTracking()
            .Where(v => v.CabinetId == id);

        if (query.FromUtc is { } from)
        {
            rows = rows.Where(v => v.LastObservedUtc >= from);
        }

        if (query.ToUtc is { } to)
        {
            rows = rows.Where(v => v.FirstObservedUtc < to);
        }

        int total = await rows.CountAsync(ct);

        List<InventoryVersionDto> items = (await rows
                .OrderByDescending(v => v.LastObservedUtc)
                .Skip(query.Skip)
                .Take(query.PageSize)
                .ToListAsync(ct))
            .Select(ToDto)
            .ToList();

        await _audit.WriteAsync(Observed(AuditEvent.ViewCabinetInventory, new
        {
            CabinetId = id,
            ResultCount = items.Count,
        }, id), ct);

        return Ok(PagedResult<InventoryVersionDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>One cabinet's SMART history, the series failure prediction runs on.</summary>
    /// <param name="id">The cabinet.</param>
    /// <param name="query">Window, drive and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("{id:guid}/smart")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<SmartReadingDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PagedResult<SmartReadingDto>>> Smart(
        Guid id, [FromQuery] SmartHistoryQuery query, CancellationToken ct)
    {
        if (!await _db.Cabinets.AsNoTracking().AnyAsync(c => c.Id == id, ct))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewSmartHistory, "Cabinet not found.", id, null, null, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        OperationResult<(DateTimeOffset From, DateTimeOffset To)> window = ResolveWindow(query);

        if (!window.Succeeded)
        {
            // A refused request is still a request. Silently 400-ing a range
            // that policy would not serve leaves no trace that somebody asked
            // for three years of one cabinet's history.
            await _audit.WriteDenialAsync(
                AuditEvent.ViewSmartHistory, window.Reason!, id,
                new { query.FromUtc, query.ToUtc }, null, ct);

            return Problem(window);
        }

        IQueryable<Domain.SmartReading> rows = _db.SmartReadings.AsNoTracking()
            .Where(s => s.CabinetId == id &&
                        s.TimestampUtc >= window.Value.From &&
                        s.TimestampUtc < window.Value.To);

        if (!string.IsNullOrWhiteSpace(query.DriveSerial))
        {
            string serial = query.DriveSerial.Trim();
            rows = rows.Where(s => s.DriveSerial == serial);
        }

        int total = await rows.CountAsync(ct);

        List<SmartReadingDto> items = (await rows
                .OrderByDescending(s => s.TimestampUtc)
                .Skip(query.Skip)
                .Take(query.PageSize)
                .ToListAsync(ct))
            .Select(ToDto)
            .ToList();

        await _audit.WriteAsync(Observed(AuditEvent.ViewSmartHistory, new
        {
            CabinetId = id,
            query.DriveSerial,
            ResultCount = items.Count,
        }, id), ct);

        return Ok(PagedResult<SmartReadingDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>Withdraws service eligibility, retaining identity and historical records.</summary>
    [HttpPost("{id:guid}/retire")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    public async Task<IActionResult> Retire(
        Guid id, [FromBody] RetireCabinetRequest request, CancellationToken ct)
    {
        await using var transaction = await _db.Database.BeginTransactionAsync(ct);
        // A conditional write serializes retries and shares ingestion's cabinet lock.
        int changed = await _db.Cabinets.Where(c => c.Id == id && c.IsActive)
            .ExecuteUpdateAsync(set => set.SetProperty(c => c.IsActive, false), ct);
        var cabinet = await _db.Cabinets.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id, ct);
        if (cabinet is null) return NotFound();

        // Clear the operational designation, not the historical cabinet role.
        await _db.Sites.Where(s => s.SyncCabinetId == id)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.SyncCabinetId, (Guid?)null), ct);
        if (changed == 0)
        {
            // Repair old invalid designations without duplicating the original audit.
            await transaction.CommitAsync(ct);
            return NoContent();
        }

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.RetireCabinet, EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success, ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(), ActorDisplayName = CurrentUser.Username,
            CabinetId = cabinet.Id, CabinetHostname = cabinet.Hostname,
            Reason = request.Reason.Trim(), Details = new { cabinet.SiteId, PreviousIsActive = true, IsActive = false }
        });
        await _db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return NoContent();
    }

    /// <summary>Changes the friendly label without changing device identity.</summary>
    [HttpPatch("{id:guid}/name")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    public async Task<ActionResult<CabinetSummary>> Rename(
        Guid id, [FromBody] RenameCabinetRequest request, CancellationToken ct)
    {
        var cabinet = await _db.Cabinets.FirstOrDefaultAsync(c => c.Id == id, ct);
        if (cabinet is null) return NotFound();
        string? previous = cabinet.FriendlyName;
        cabinet.FriendlyName = request.FriendlyName.Trim();
        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.RenameCabinet, EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success, ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(), ActorDisplayName = CurrentUser.Username,
            CabinetId = cabinet.Id, CabinetHostname = cabinet.Hostname,
            Reason = request.Reason.Trim(), Details = new { Previous = previous, cabinet.FriendlyName }
        });
        await _db.SaveChangesAsync(ct);
        return Ok((await _projection.ProjectAsync(_db.Cabinets.AsNoTracking().Where(c => c.Id == id),
            _timeProvider.GetUtcNow(), ct)).Single());
    }

    /// <summary>
    /// Changes a cabinet's part in its site's topology.
    /// </summary>
    /// <remarks>
    /// Promoting a cabinet where its site already has a sync cabinet is
    /// refused: a site has exactly one, and demoting the incumbent is a
    /// separate decision somebody has to make and own.
    /// </remarks>
    /// <param name="id">The cabinet.</param>
    /// <param name="request">The new role and why.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPut("{id:guid}/role")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(CabinetSummary), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<CabinetSummary>> SetRole(
        Guid id, [FromBody] SetCabinetRoleRequest request, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        await using var transaction = await _db.Database.BeginTransactionAsync(ct);
        // Match retirement's cabinet-first write lock and hold it through the
        // topology and audit commit. A tracked entity is not an activity check.
        int active = await _db.Cabinets.Where(c => c.Id == id && c.IsActive)
            .ExecuteUpdateAsync(set => set.SetProperty(c => c.IsActive, c => c.IsActive), ct);
        if (active == 0 && await _db.Cabinets.AsNoTracking().AnyAsync(c => c.Id == id, ct))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.SetCabinetRole, "Cabinet is inactive.", id, null, null, ct);
            await transaction.CommitAsync(ct);
            return Problem("Cabinet is inactive.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        Domain.Cabinet? cabinet = await _db.Cabinets
            .Include(c => c.Site)
            .FirstOrDefaultAsync(c => c.Id == id, ct);

        if (cabinet?.Site is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.SetCabinetRole, "Cabinet not found.", id, null, null, ct);
            await transaction.CommitAsync(ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        // Queries can return pre-lock tracked instances. Refresh both sides of
        // the topology decision while holding locks in cabinet-then-site order.
        await _db.Entry(cabinet).ReloadAsync(ct);
        await _db.Sites.Where(s => s.Id == cabinet.SiteId)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.SyncCabinetId, s => s.SyncCabinetId), ct);
        await _db.Entry(cabinet.Site).ReloadAsync(ct);

        if (request.Role == CabinetRole.Unknown)
        {
            return Problem("A cabinet's role cannot be set back to Unknown.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        CabinetRole previous = cabinet.Role;
        Domain.Site site = cabinet.Site;

        if (request.Role == CabinetRole.Sync &&
            site.SyncCabinetId is { } existing &&
            existing != cabinet.Id)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.SetCabinetRole,
                "Site already has a sync cabinet.",
                id,
                new { site.Id, ExistingSyncCabinetId = existing },
                null,
                ct);

            await transaction.CommitAsync(ct);
            return Problem(
                "This site already has a sync cabinet. Demote that one first — a site has exactly one.",
                statusCode: StatusCodes.Status409Conflict,
                title: "Conflict");
        }

        cabinet.Role = request.Role;

        if (request.Role == CabinetRole.Sync)
        {
            site.SyncCabinetId = cabinet.Id;
        }
        else if (site.SyncCabinetId == cabinet.Id)
        {
            // Demoting the incumbent leaves the site standalone until somebody
            // promotes another. That is a real state, not a broken one.
            site.SyncCabinetId = null;
        }

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.SetCabinetRole,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(),
            ActorDisplayName = CurrentUser.Username,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            Reason = request.Reason.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? null
                : request.TicketReference.Trim(),
            Details = new
            {
                SiteId = site.Id,
                PreviousRole = previous.ToString(),
                NewRole = request.Role.ToString(),
                SiteSyncCabinetId = site.SyncCabinetId,
            },
        });

        try
        {
            await _db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();
            return Problem(
                "This cabinet was changed by someone else while you were deciding. Reload and try again.",
                statusCode: StatusCodes.Status409Conflict,
                title: "Conflict");
        }

        CabinetSummary summary =
            (await _projection.ProjectAsync(
                _db.Cabinets.AsNoTracking().Where(c => c.Id == id), nowUtc, ct)).Single();

        return Ok(summary);
    }

    /// <summary>
    /// One row per drive: the newest reading for each serial this cabinet has
    /// ever reported, rather than the newest handful overall.
    /// </summary>
    /// <remarks>
    /// Expressed as a correlated max rather than <c>GroupBy().Select(g =&gt;
    /// g.First())</c>, which no relational provider can translate and which
    /// therefore threw on every cabinet that had ever reported a drive.
    /// </remarks>
    private async Task<List<SmartReadingDto>> NewestSmartPerDriveAsync(Guid id, CancellationToken ct)
    {
        List<Domain.SmartReading> newestPerDrive = await _db.SmartReadings.AsNoTracking()
            .Where(s => s.CabinetId == id)
            .Where(s => s.TimestampUtc == _db.SmartReadings
                .Where(other => other.CabinetId == id && other.DriveSerial == s.DriveSerial)
                .Max(other => other.TimestampUtc))
            .ToListAsync(ct);

        // A drive can hold two rows at the identical instant once retention has
        // rolled a day up, so the tie is broken in memory — over a handful of
        // drives, not a table scan. The as-sampled reading wins: it is the
        // actual observation, and the roll-up is a summary of it.
        return newestPerDrive
            .GroupBy(s => s.DriveSerial)
            .Select(g => ToDto(g.OrderBy(s => s.IsAggregated).ThenBy(s => s.Id).First()))
            .ToList();
    }

    private async Task<SiteSummary> ProjectSiteAsync(Guid siteId, DateTimeOffset nowUtc, CancellationToken ct)
    {
        Domain.Site site = await _db.Sites.AsNoTracking()
            .Include(s => s.Client)
            .FirstAsync(s => s.Id == siteId, ct);

        List<CabinetSummary> members = await _projection.ProjectAsync(
            _db.Cabinets.AsNoTracking().Where(c => c.IsActive && c.SiteId == siteId), nowUtc, ct);

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
            WorstHealth = members.Aggregate(
                CabinetHealthStatus.Healthy, (worst, c) => HealthEvaluator.Worse(worst, c.Health)),
        };
    }

    private async Task<SyncCabinetLinkDto?> ProjectSyncLinkAsync(
        Domain.Cabinet cabinet, SiteSummary site, DateTimeOffset nowUtc, CancellationToken ct)
    {
        if (site.SyncCabinetId is not { } syncId || syncId == cabinet.Id)
        {
            return null;
        }

        CabinetSummary? sync = (await _projection.ProjectAsync(
            _db.Cabinets.AsNoTracking().Where(c => c.Id == syncId), nowUtc, ct)).FirstOrDefault();

        if (sync is null)
        {
            return null;
        }

        Domain.CabinetLinkProbe? probe = await _db.CabinetLinkProbes.AsNoTracking()
            .FirstOrDefaultAsync(p => p.SourceCabinetId == cabinet.Id && p.TargetCabinetId == syncId, ct);

        return new SyncCabinetLinkDto
        {
            SyncCabinetId = sync.Id,
            SyncCabinetHostname = sync.Hostname,
            SyncCabinetHealth = sync.Health,
            SyncCabinetLastCheckInUtc = sync.LastCheckInUtc,
            // Null until somebody actually probes it. Reachable from the server
            // is a different question and must not be presented as this one.
            LastProbeReachable = probe?.Reachable,
            LastProbeUtc = probe?.ObservedUtc,
            LastProbeLatencyMs = probe?.LatencyMs,
        };
    }

    private OperationResult<(DateTimeOffset From, DateTimeOffset To)> ResolveWindow(HistoryQuery query)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();
        DateTimeOffset to = query.ToUtc ?? nowUtc;
        DateTimeOffset from = query.FromUtc ?? to.AddDays(-_queryLimits.DefaultHistoryRangeDays);

        if (from >= to)
        {
            return OperationResult<(DateTimeOffset, DateTimeOffset)>.Invalid(
                "The history window's start must be before its end.");
        }

        if (to - from > TimeSpan.FromDays(_queryLimits.MaxHistoryRangeDays))
        {
            // Refused rather than silently clamped, so the caller learns their
            // query was wrong instead of quietly receiving less than they asked.
            return OperationResult<(DateTimeOffset, DateTimeOffset)>.Invalid(
                $"A history window may span at most {_queryLimits.MaxHistoryRangeDays} days.");
        }

        return OperationResult<(DateTimeOffset, DateTimeOffset)>.Ok((from, to));
    }

    private static HeartbeatDto ToDto(Domain.Heartbeat h) => new()
    {
        Id = h.Id,
        ReceivedUtc = h.ReceivedUtc,
        CollectedAtUtc = h.CollectedAtUtc,
        AgentVersion = h.AgentVersion,
        Uptime = h.UptimeSeconds is { } seconds ? TimeSpan.FromSeconds(seconds) : null,
        CpuPercent = h.CpuPercent,
        RamUsedPercent = h.RamUsedPercent,
        MinFreeDiskPercent = h.MinFreeDiskPercent,
        WorstDiskHealth = h.WorstDiskHealth,
        AnyUserLoggedOn = h.AnyUserLoggedOn,
        PendingUpdateCount = h.PendingUpdateCount,
        RebootPending = h.RebootPending,
        ClockDrift = h.ClockDriftSeconds is { } drift ? TimeSpan.FromSeconds(drift) : null,
        SectionErrors = DeserialiseErrors(h.SectionErrorsJson),
        IsAggregated = h.IsAggregated,
    };

    private static InventoryVersionDto ToDto(Domain.InventoryVersion v)
    {
        StoredInventory? stored = null;

        try
        {
            stored = JsonSerializer.Deserialize<StoredInventory>(v.PayloadJson, ContractJson.Default);
        }
        catch (JsonException)
        {
            // A document this build cannot read is reported as a version with
            // no sections rather than failing the whole response: the fact that
            // the inventory changed, and when, is still true.
        }

        return new InventoryVersionDto
        {
            Id = v.Id,
            FirstObservedUtc = v.FirstObservedUtc,
            LastObservedUtc = v.LastObservedUtc,
            ContentHash = v.ContentHash,
            System = stored?.System,
            Services = stored?.Services,
            Network = stored?.Network,
            WindowsUpdate = stored?.WindowsUpdate,
            Disks = stored?.Disks,
            InstalledMemoryBytes = stored?.Performance?.RamTotalBytes,
            StartupPrograms = stored?.Performance?.StartupPrograms,
            SectionErrors = DeserialiseErrors(v.SectionErrorsJson),
        };
    }

    private static SmartReadingDto ToDto(Domain.SmartReading s) => new()
    {
        Id = s.Id,
        DriveSerial = s.DriveSerial,
        DriveModel = s.DriveModel,
        TimestampUtc = s.TimestampUtc,
        Health = s.Health,
        Source = s.Source,
        IsAggregated = s.IsAggregated,
        Smart = new SmartInfo
        {
            Source = s.Source,
            ReallocatedSectorCount = s.ReallocatedSectorCount,
            PendingSectorCount = s.PendingSectorCount,
            UncorrectableErrorCount = s.UncorrectableErrorCount,
            PowerOnHours = s.PowerOnHours,
            TemperatureCelsius = s.TemperatureCelsius,
            OverallPredictFailure = s.OverallPredictFailure,
            PredictFailureReason = s.PredictFailureReason,
            Wear = s.Wear,
            ReadErrorsTotal = s.ReadErrorsTotal,
            ReadErrorsUncorrected = s.ReadErrorsUncorrected,
            WriteErrorsTotal = s.WriteErrorsTotal,
            WriteErrorsUncorrected = s.WriteErrorsUncorrected,
            TemperatureMax = s.TemperatureMax,
            StartStopCycleCount = s.StartStopCycleCount,
            SerialNumber = s.DriveSerial,
            Model = s.DriveModel,
        },
    };

    private static IReadOnlyDictionary<string, string> DeserialiseErrors(string json)
    {
        try
        {
            Dictionary<string, string>? read =
                JsonSerializer.Deserialize<Dictionary<string, string>>(json, ContractJson.Default);

            // Rebuilt case-insensitively. Stored parameter names are the
            // catalog's, but a dictionary that compares ordinally turns any
            // future difference in case into an action the agent silently
            // declines, for a reason visible from neither side.
            return read is null
                ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, string>(read, StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private AuditRecord Observed(AuditEvent auditEvent, object details, Guid? cabinetId = null) => new()
    {
        Event = auditEvent,
        EventKind = AuditEventKind.Observed,
        Result = AuditResult.Success,
        ActorType = ActorType.User,
        ActorId = CurrentUser.UserId.ToString(),
        ActorDisplayName = CurrentUser.Username,
        CabinetId = cabinetId,
        Details = details,
    };

    /// <summary>The shape an inventory version is stored in.</summary>
    private sealed record StoredInventory
    {
        public SystemInfo? System { get; init; }

        public IReadOnlyList<ServiceInfo>? Services { get; init; }

        public NetworkInfo? Network { get; init; }

        public WindowsUpdateInfo? WindowsUpdate { get; init; }

        public IReadOnlyList<DiskInfo>? Disks { get; init; }

        /// <summary>
        /// The performance section as it was stored. Only its configuration
        /// facts are read back: the counters in it were a sample taken at one
        /// instant six hours ago and would be misleading shown as current.
        /// </summary>
        public PerformanceInfo? Performance { get; init; }
    }
}
