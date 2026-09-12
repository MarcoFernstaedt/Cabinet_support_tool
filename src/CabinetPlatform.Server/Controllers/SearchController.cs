using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace CabinetPlatform.Server.Controllers;

/// <summary>
/// Finding a cabinet: by search, by hierarchy, or by what this rep looked at
/// last.
/// </summary>
/// <remarks>
/// <para>
/// Three routes to the same place, because reps arrive from three directions.
/// One has a name or a serial number from a caller. One has a client on the
/// phone and does not yet know which site. One is coming back to the cabinet
/// they were on ten minutes ago.
/// </para>
/// <para>
/// Every response here identifies a cabinet by its full path — client, site,
/// department, name and role — and never by hostname alone. Across three and a
/// half thousand organisations hostnames repeat constantly, and picking the
/// wrong cabinet is the most likely serious operator error this product has.
/// </para>
/// </remarks>
[Route("api/search")]
public sealed class SearchController : SupportControllerBase
{
    private readonly ICabinetSearchService _search;
    private readonly IAuditService _audit;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the controller.</summary>
    /// <param name="search">Finds cabinets and builds their paths.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="timeProvider">Clock.</param>
    public SearchController(
        ICabinetSearchService search, IAuditService audit, TimeProvider timeProvider)
    {
        _search = search;
        _audit = audit;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// Searches across client name, site name, department, hostname, serial
    /// number and cabinet id at once.
    /// </summary>
    /// <remarks>
    /// Partial and case-insensitive, paged, with the page size clamped by the
    /// shared query type rather than by this endpoint remembering to.
    /// </remarks>
    /// <param name="query">What to look for, and which page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("cabinets")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<CabinetSearchHit>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<CabinetSearchHit>>> Cabinets(
        [FromQuery] CabinetSearchQuery query, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        PagedResult<CabinetSearchHit> result = await _search.SearchAsync(query, nowUtc, ct);

        // Searching is reading, so this is Observed. It is still recorded: with
        // no case scoping and no per-rep assignment, the trail of what was
        // looked for is the control that replaces them.
        await _audit.WriteAsync(Observed(AuditEvent.SearchCabinets, new
        {
            query.Term,
            query.Page,
            query.PageSize,
            result.TotalCount,
            ResultCount = result.Items.Count,
        }), ct);

        return Ok(result);
    }

    /// <summary>The client list, for the top level of the hierarchy browser.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("clients")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<ClientSummary>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<ClientSummary>>> Clients(
        [FromQuery] ClientQuery query, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        PagedResult<ClientSummary> result = await _search.ListClientsAsync(query, nowUtc, ct);

        await _audit.WriteAsync(Observed(AuditEvent.ListClients, new
        {
            query.Search,
            query.Page,
            result.TotalCount,
        }), ct);

        return Ok(result);
    }

    /// <summary>
    /// One client's sites, each with its cabinets and the sync cabinet first.
    /// </summary>
    /// <param name="id">The client.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("clients/{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ClientHierarchyDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ClientHierarchyDto>> Hierarchy(Guid id, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        OperationResult<ClientHierarchyDto> result = await _search.GetHierarchyAsync(id, nowUtc, ct);

        if (!result.Succeeded)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewClientHierarchy, result.Reason!, null, new { ClientId = id }, null, ct);

            return Problem(result);
        }

        await _audit.WriteAsync(Observed(AuditEvent.ViewClientHierarchy, new
        {
            ClientId = id,
            result.Value!.Client.Name,
            result.Value.Client.SiteCount,
            result.Value.Client.CabinetCount,
        }), ct);

        return Ok(result.Value);
    }

    /// <summary>
    /// The cabinets this rep has opened most recently.
    /// </summary>
    /// <remarks>
    /// Scoped to the calling user by the token, not by a parameter. A rep
    /// cannot ask for somebody else's list, and there is no endpoint that would
    /// serve one.
    /// </remarks>
    /// <param name="limit">How many to return.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("recent")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(IReadOnlyList<RecentCabinetDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<RecentCabinetDto>>> Recent(
        [FromQuery] int limit, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();
        CurrentUser actor = CurrentUser;

        IReadOnlyList<RecentCabinetDto> recent = await _search.GetRecentAsync(
            actor.UserId,
            limit <= 0 ? CabinetSearchService.MaximumRecentCabinets : limit,
            nowUtc,
            ct);

        await _audit.WriteAsync(
            Observed(AuditEvent.ViewRecentCabinets, new { ResultCount = recent.Count }), ct);

        return Ok(recent);
    }

    private AuditRecord Observed(AuditEvent auditEvent, object details)
    {
        CurrentUser actor = CurrentUser;

        return new AuditRecord
        {
            Event = auditEvent,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = details,
        };
    }
}
