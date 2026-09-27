using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Services;

/// <summary>
/// Finding a cabinet, and saying unambiguously which one was found.
/// </summary>
/// <remarks>
/// <para>
/// With three and a half thousand organisations and seven thousand cabinets,
/// picking the wrong cabinet is the most likely serious operator error this
/// product has. Every method here returns a
/// <see cref="Contracts.Cabinets.CabinetPath"/> rather than a hostname, and
/// marks the paths within a result set whose names collide, because
/// <c>CUBEX01</c> is a name hundreds of clients have chosen independently.
/// </para>
/// <para>
/// Search and hierarchy are both here because they answer the same question
/// from opposite ends. Search is for a rep holding a name, a serial number or a
/// ticket. The hierarchy is for a rep whose client has rung and who does not
/// yet know which of that client's sites is involved.
/// </para>
/// </remarks>
public interface ICabinetSearchService
{
    /// <summary>Runs a search across every identifying column.</summary>
    /// <param name="query">What to look for, and which page.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="ct">Cancels the query.</param>
    Task<PagedResult<CabinetSearchHit>> SearchAsync(
        CabinetSearchQuery query, DateTimeOffset nowUtc, CancellationToken ct);

    /// <summary>Lists client organisations for the hierarchy browser.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="ct">Cancels the query.</param>
    Task<PagedResult<ClientSummary>> ListClientsAsync(
        ClientQuery query, DateTimeOffset nowUtc, CancellationToken ct);

    /// <summary>One client's sites, each with its cabinets, sync cabinet first.</summary>
    /// <param name="clientId">The client.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="ct">Cancels the query.</param>
    Task<OperationResult<ClientHierarchyDto>> GetHierarchyAsync(
        Guid clientId, DateTimeOffset nowUtc, CancellationToken ct);

    /// <summary>The cabinets this rep has opened most recently.</summary>
    /// <param name="userId">The rep.</param>
    /// <param name="limit">How many to return.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="ct">Cancels the query.</param>
    Task<IReadOnlyList<RecentCabinetDto>> GetRecentAsync(
        Guid userId, int limit, DateTimeOffset nowUtc, CancellationToken ct);

    /// <summary>
    /// Records that a rep has opened a cabinet, so it appears in their recent
    /// list.
    /// </summary>
    /// <remarks>
    /// Does not save: the caller decides when to commit, so opening a cabinet
    /// costs one round trip rather than two. One row per rep and cabinet,
    /// updated in place — a history of every view would be a second audit trail
    /// with none of the guarantees of the real one, and the real one already
    /// records every read.
    /// </remarks>
    /// <param name="userId">The rep.</param>
    /// <param name="cabinetId">The cabinet they opened.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="ct">Cancels the query.</param>
    Task RecordViewAsync(Guid userId, Guid cabinetId, DateTimeOffset nowUtc, CancellationToken ct);
}

/// <inheritdoc />
public sealed class CabinetSearchService : ICabinetSearchService
{
    /// <summary>
    /// How many recent cabinets a rep's list holds.
    /// </summary>
    /// <remarks>
    /// Short on purpose. The list exists to shorten "the one I was just looking
    /// at" to one click; a list long enough to need scanning is a second search
    /// box with worse ranking.
    /// </remarks>
    public const int MaximumRecentCabinets = 20;

    private readonly SupportDbContext _db;
    private readonly ICabinetProjection _projection;
    private readonly AgentIngestOptions _ingest;

    /// <summary>Creates the service.</summary>
    /// <param name="db">The database.</param>
    /// <param name="projection">Builds cabinet read models from extracted columns.</param>
    /// <param name="ingest">Supplies the offline threshold.</param>
    public CabinetSearchService(
        SupportDbContext db,
        ICabinetProjection projection,
        IOptions<AgentIngestOptions> ingest)
    {
        _db = db;
        _projection = projection;
        _ingest = ingest.Value;
    }

    /// <inheritdoc />
    public async Task<PagedResult<CabinetSearchHit>> SearchAsync(
        CabinetSearchQuery query, DateTimeOffset nowUtc, CancellationToken ct)
    {
        IQueryable<Cabinet> cabinets = _db.Cabinets.AsNoTracking();

        if (query.IsActive is { } isActive)
        {
            cabinets = cabinets.Where(c => c.IsActive == isActive);
        }

        string term = query.Term?.Trim() ?? string.Empty;
        Guid? exactId = Guid.TryParse(term, out Guid parsedId) ? parsedId : null;

        if (term.Length > 0)
        {
            // One term across every identifying column, because a rep does not
            // know in advance which kind of thing they are holding: the client
            // who rang, the site they named, the sticker on the cabinet, the
            // serial number underneath it, or an id pasted from a ticket.
            // Asking them to pick a field first is asking a question they
            // cannot answer.
            //
            // LIKE with a leading wildcard, deliberately. Partial matches are
            // most of what reps have — "Riverside" for "Riverside Veterinary
            // Group" — and the indexes on these columns still narrow the join
            // before the scan. At seven thousand rows this is the right trade;
            // it is documented so that whoever revisits it at seventy thousand
            // knows what to replace it with.
            string pattern = $"%{Escape(term)}%";

            cabinets = cabinets.Where(c =>
                EF.Functions.Like(c.Hostname, pattern) ||
                EF.Functions.Like(c.FriendlyName ?? string.Empty, pattern) ||
                EF.Functions.Like(c.SerialNumber ?? string.Empty, pattern) ||
                EF.Functions.Like(c.DepartmentName ?? string.Empty, pattern) ||
                EF.Functions.Like(c.Site!.Name, pattern) ||
                EF.Functions.Like(c.Site!.Client!.Name, pattern) ||
                (exactId != null && c.Id == exactId));
        }

        int total = await cabinets.CountAsync(ct);

        // The ordering is the identification, not an afterthought: client, then
        // site, then the sync cabinet ahead of its satellites, then name. A rep
        // scanning results reads them as a path rather than as a flat list.
        IQueryable<Cabinet> page = cabinets
            .OrderBy(c => c.Site!.Client!.Name)
            .ThenBy(c => c.Site!.Name)
            .ThenBy(c => c.DepartmentName)
            .ThenBy(c => c.Role == CabinetRole.Sync ? 0 : 1)
            .ThenBy(c => c.Hostname)
            .ThenBy(c => c.Id)
            .Skip(query.Skip)
            .Take(query.PageSize);

        List<CabinetSummary> summaries = await _projection.ProjectAsync(page, nowUtc, ct);

        IReadOnlyList<CabinetPath> paths = CabinetPath.MarkAmbiguity(
            summaries.Select(s => CabinetPath.From(s)).ToList());

        List<CabinetSearchHit> hits = summaries
            .Select((summary, index) => new CabinetSearchHit
            {
                Cabinet = summary,
                Path = paths[index],
                MatchedOn = Classify(summary, term, exactId),
            })
            .ToList();

        return PagedResult<CabinetSearchHit>.Create(hits, query.Page, query.PageSize, total);
    }

    /// <inheritdoc />
    public async Task<PagedResult<ClientSummary>> ListClientsAsync(
        ClientQuery query, DateTimeOffset nowUtc, CancellationToken ct)
    {
        IQueryable<Client> clients = _db.Clients.AsNoTracking();

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            clients = clients.Where(c => EF.Functions.Like(c.Name, $"%{Escape(query.Search.Trim())}%"));
        }

        int total = await clients.CountAsync(ct);

        // Counts come from the database rather than from loading the cabinets:
        // the top level of a hierarchy browser must not be proportional to the
        // size of the fleet underneath it.
        var rows = await clients
            .OrderBy(c => c.Name)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .Select(c => new
            {
                c.Id,
                c.Name,
                SiteCount = c.Sites.Count,
                CabinetCount = c.Sites.SelectMany(s => s.Cabinets).Count(),
                CabinetIds = c.Sites.SelectMany(s => s.Cabinets).Select(cab => cab.Id).ToList(),
            })
            .ToListAsync(ct);

        var summaries = new List<ClientSummary>(rows.Count);

        foreach (var row in rows)
        {
            // Worst health across one page of clients, projected per cabinet
            // from the extracted columns. Bounded by the page, so a client with
            // four hundred cabinets costs one query rather than four hundred.
            List<CabinetSummary> members = row.CabinetIds.Count == 0
                ? new List<CabinetSummary>()
                : await _projection.ProjectAsync(
                    _db.Cabinets.AsNoTracking().Where(c => row.CabinetIds.Contains(c.Id)), nowUtc, ct);

            summaries.Add(new ClientSummary
            {
                Id = row.Id,
                Name = row.Name,
                SiteCount = row.SiteCount,
                CabinetCount = row.CabinetCount,
                WorstHealth = members.Aggregate(
                    CabinetHealthStatus.Healthy, (worst, c) => HealthEvaluator.Worse(worst, c.Health)),
            });
        }

        return PagedResult<ClientSummary>.Create(summaries, query.Page, query.PageSize, total);
    }

    /// <inheritdoc />
    public async Task<OperationResult<ClientHierarchyDto>> GetHierarchyAsync(
        Guid clientId, DateTimeOffset nowUtc, CancellationToken ct)
    {
        Client? client = await _db.Clients.AsNoTracking().FirstOrDefaultAsync(c => c.Id == clientId, ct);

        if (client is null)
        {
            return OperationResult<ClientHierarchyDto>.NotFound("Client not found.");
        }

        List<Site> sites = await _db.Sites.AsNoTracking()
            .Where(s => s.ClientId == clientId)
            .OrderBy(s => s.Name)
            .ToListAsync(ct);

        List<CabinetSummary> members = await _projection.ProjectAsync(
            _db.Cabinets.AsNoTracking().Where(c => c.Site!.ClientId == clientId), nowUtc, ct);

        var bySite = members.GroupBy(m => m.SiteId).ToDictionary(g => g.Key, g => g.ToList());

        var siteDtos = new List<SiteWithCabinetsDto>(sites.Count);

        foreach (Site site in sites)
        {
            List<CabinetSummary> cabinets = bySite.GetValueOrDefault(site.Id) ?? new List<CabinetSummary>();

            // The sync cabinet leads. When a whole site misbehaves it is
            // usually the cause, and a rep should not have to find it among
            // twenty rows sorted by a name somebody chose in 2014.
            List<CabinetSummary> ordered = cabinets
                .OrderBy(c => c.Id == site.SyncCabinetId ? 0 : 1)
                .ThenBy(c => c.DepartmentName)
                .ThenBy(c => c.Hostname, StringComparer.OrdinalIgnoreCase)
                .ToList();

            siteDtos.Add(new SiteWithCabinetsDto
            {
                Site = BuildSiteSummary(site, client.Name, ordered, syncReachability: null),
                Cabinets = CabinetPath.MarkAmbiguity(ordered.Select(c => CabinetPath.From(c)).ToList()),
            });
        }

        var dto = new ClientHierarchyDto
        {
            Client = new ClientSummary
            {
                Id = client.Id,
                Name = client.Name,
                SiteCount = sites.Count,
                CabinetCount = members.Count,
                WorstHealth = members.Aggregate(
                    CabinetHealthStatus.Healthy, (worst, c) => HealthEvaluator.Worse(worst, c.Health)),
            },
            // Worst first: a rep opening a client wants the site that is on fire
            // above the twelve that are not.
            Sites = siteDtos
                .OrderByDescending(s => (int)s.Site.WorstHealth)
                .ThenBy(s => s.Site.SiteName, StringComparer.OrdinalIgnoreCase)
                .ToList(),
        };

        return OperationResult<ClientHierarchyDto>.Ok(dto);
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<RecentCabinetDto>> GetRecentAsync(
        Guid userId, int limit, DateTimeOffset nowUtc, CancellationToken ct)
    {
        int take = Math.Clamp(limit, 1, MaximumRecentCabinets);

        var rows = await _db.RecentCabinetViews.AsNoTracking()
            .Where(r => r.UserId == userId)
            .OrderByDescending(r => r.LastViewedUtc)
            .Take(take)
            .Select(r => new { r.CabinetId, r.LastViewedUtc })
            .ToListAsync(ct);

        if (rows.Count == 0)
        {
            return Array.Empty<RecentCabinetDto>();
        }

        var ids = rows.Select(r => r.CabinetId).ToList();

        List<CabinetSummary> summaries = await _projection.ProjectAsync(
            _db.Cabinets.AsNoTracking().Where(c => ids.Contains(c.Id)), nowUtc, ct);

        IReadOnlyList<CabinetPath> paths = CabinetPath.MarkAmbiguity(
            summaries.Select(s => CabinetPath.From(s)).ToList());

        var pathById = paths.ToDictionary(p => p.CabinetId);
        var healthById = summaries.ToDictionary(s => s.Id, s => s.Health);

        return rows
            // A cabinet decommissioned since the rep last opened it drops out
            // rather than appearing as a blank row.
            .Where(r => pathById.ContainsKey(r.CabinetId))
            .Select(r => new RecentCabinetDto
            {
                Path = pathById[r.CabinetId],
                LastViewedUtc = r.LastViewedUtc,
                Health = healthById[r.CabinetId],
            })
            .ToList();
    }

    /// <inheritdoc />
    public async Task RecordViewAsync(
        Guid userId, Guid cabinetId, DateTimeOffset nowUtc, CancellationToken ct)
    {
        RecentCabinetView? existing = await _db.RecentCabinetViews
            .FirstOrDefaultAsync(r => r.UserId == userId && r.CabinetId == cabinetId, ct);

        if (existing is not null)
        {
            existing.LastViewedUtc = nowUtc;
            return;
        }

        _db.RecentCabinetViews.Add(new RecentCabinetView
        {
            UserId = userId,
            CabinetId = cabinetId,
            LastViewedUtc = nowUtc,
        });

        // Trimmed here rather than by a sweep, because the list is per rep and
        // tiny: twenty reps times twenty rows is four hundred, and a background
        // job for that would be more machinery than the thing it maintains.
        List<RecentCabinetView> surplus = await _db.RecentCabinetViews
            .Where(r => r.UserId == userId)
            .OrderByDescending(r => r.LastViewedUtc)
            .Skip(MaximumRecentCabinets - 1)
            .ToListAsync(ct);

        if (surplus.Count > 0)
        {
            _db.RecentCabinetViews.RemoveRange(surplus);
        }
    }

    /// <summary>
    /// Builds a site summary from already-projected members.
    /// </summary>
    /// <param name="site">The site.</param>
    /// <param name="clientName">Its client's name.</param>
    /// <param name="members">Its cabinets, already projected.</param>
    /// <param name="syncReachability">How its satellites last found the sync cabinet.</param>
    public static SiteSummary BuildSiteSummary(
        Site site,
        string clientName,
        IReadOnlyList<CabinetSummary> members,
        SyncReachabilitySummary? syncReachability)
    {
        CabinetSummary? sync = members.FirstOrDefault(c => c.Id == site.SyncCabinetId);

        return new SiteSummary
        {
            Id = site.Id,
            ClientName = clientName,
            SiteName = site.Name,
            SyncCabinetId = site.SyncCabinetId,
            SyncCabinetHostname = sync?.Hostname,
            SyncCabinetHealth = sync?.Health,
            CabinetCount = members.Count,
            UnhealthyCabinetCount = members.Count(c => c.Health != CabinetHealthStatus.Healthy),
            WorstHealth = members.Aggregate(
                CabinetHealthStatus.Healthy, (worst, c) => HealthEvaluator.Worse(worst, c.Health)),
            SyncReachability = syncReachability,
        };
    }

    /// <summary>
    /// Says which field the term matched, so a rep can see why a row is in the
    /// result.
    /// </summary>
    /// <remarks>
    /// Re-derived here rather than returned by the query, because a row can
    /// match several columns and SQL would have to be told which one to prefer
    /// anyway. The order is the order a rep would expect: an exact id beats a
    /// serial number, which beats a name they may have typed loosely.
    /// </remarks>
    private static CabinetSearchMatch Classify(CabinetSummary summary, string term, Guid? exactId)
    {
        if (term.Length == 0)
        {
            return CabinetSearchMatch.None;
        }

        if (exactId is { } id && summary.Id == id)
        {
            return CabinetSearchMatch.CabinetId;
        }

        if (Contains(summary.SerialNumber, term))
        {
            return CabinetSearchMatch.SerialNumber;
        }

        if (Contains(summary.Hostname, term))
        {
            return CabinetSearchMatch.Hostname;
        }

        if (Contains(summary.DepartmentName, term))
        {
            return CabinetSearchMatch.Department;
        }

        if (Contains(summary.SiteName, term))
        {
            return CabinetSearchMatch.SiteName;
        }

        return Contains(summary.ClientName, term)
            ? CabinetSearchMatch.ClientName
            : CabinetSearchMatch.None;
    }

    private static bool Contains(string? value, string term) =>
        !string.IsNullOrEmpty(value) && value.Contains(term, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Neutralises the wildcards in a LIKE pattern.
    /// </summary>
    /// <remarks>
    /// A rep typing a percent sign into the search box should search for a
    /// percent sign, not match every cabinet in the fleet. Both providers
    /// recognise square brackets as a character class in LIKE, so the three
    /// characters are wrapped rather than escaped, which avoids needing an
    /// ESCAPE clause the two providers spell differently.
    /// </remarks>
    private static string Escape(string term) => term
        .Replace("[", "[[]", StringComparison.Ordinal)
        .Replace("%", "[%]", StringComparison.Ordinal)
        .Replace("_", "[_]", StringComparison.Ordinal);
}
