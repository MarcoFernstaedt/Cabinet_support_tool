using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>
/// Requesting, approving and denying catalogued actions.
///
/// Nothing here accepts a command, a script or SQL. The only thing a caller
/// may name is an entry in <see cref="ActionCatalog"/>, and the only
/// parameters that survive are the ones that entry declares.
/// </summary>
[Route("api/actions")]
public sealed class ActionsController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IActionRequestService _actions;
    private readonly IAuditService _audit;

    public ActionsController(
        SupportDbContext db, IActionRequestService actions, IAuditService audit)
    {
        _db = db;
        _actions = actions;
        _audit = audit;
    }

    /// <summary>
    /// The catalogue, so the console can draw the right buttons. Advisory
    /// only — the server re-checks every rule it describes when an action is
    /// actually requested.
    /// </summary>
    [HttpGet("catalog")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(IReadOnlyList<ActionCatalogEntryDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ActionCatalogEntryDto>>> Catalog(CancellationToken ct)
    {
        List<ActionCatalogEntryDto> items = ActionCatalog.All
            .Select(e => new ActionCatalogEntryDto
            {
                Action = e.Action,
                DisplayName = e.DisplayName,
                Description = e.Description,
                MinimumRole = e.MinimumRole,
                RequiresApproval = e.RequiresApproval,
                IsDisruptive = e.IsDisruptive,
                TimeoutSeconds = e.TimeoutSeconds,
                AllowedParameterKeys = e.AllowedParameterKeys.OrderBy(k => k).ToList(),
                MaintenanceWindowOnly = e.MaintenanceWindowOnly,
                BlockedIfUserLoggedOn = e.BlockedIfUserLoggedOn
            })
            .OrderBy(e => e.Action)
            .ToList();

        await WriteObservedAsync(AuditActions.ViewActionCatalog, new { Count = items.Count }, ct);

        return Ok(items);
    }

    [HttpPost]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(ActionRequestDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ActionRequestDto>> Create(
        [FromBody] CreateActionRequest request, CancellationToken ct)
    {
        // The minimum role for the specific action is enforced inside the
        // service against the caller's token-resolved role. Tier1 here is only
        // the floor for reaching the endpoint at all.
        OperationResult<ActionRequest> result = await _actions.CreateAsync(CurrentUser, request, ct);

        if (!result.Succeeded)
        {
            return Problem(result);
        }

        ActionRequestDto dto = await LoadDtoAsync(result.Value!.Id, ct)
                               ?? throw new InvalidOperationException(
                                   "Action request vanished immediately after creation.");

        return CreatedAtAction(nameof(GetById), new { id = dto.Id }, dto);
    }

    [HttpGet("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(ActionRequestDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ActionRequestDto>> GetById(Guid id, CancellationToken ct)
    {
        ActionRequestDto? dto = await LoadDtoAsync(id, ct);

        if (dto is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.ListActions, "Action request not found.", null,
                new { ActionRequestId = id }, ct);
            return Problem("Action request not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        await WriteObservedAsync(AuditActions.ListActions, new { ActionRequestId = id }, ct);

        return Ok(dto);
    }

    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(PagedResult<ActionRequestDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<ActionRequestDto>>> List(
        [FromQuery] ActionQuery query, CancellationToken ct)
    {
        IQueryable<ActionRequest> rows = BaseQuery();

        if (query.CabinetId is { } cabinetId)
        {
            rows = rows.Where(a => a.CabinetId == cabinetId);
        }

        if (query.Status is { } status)
        {
            rows = rows.Where(a => a.Status == status);
        }

        int total = await rows.CountAsync(ct);

        List<ActionRequestDto> items = Materialise(await Project(rows)
            .OrderByDescending(r => r.Action.RequestedUtc)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .ToListAsync(ct));

        await WriteObservedAsync(AuditActions.ListActions, new
        {
            query.CabinetId,
            Status = query.Status?.ToString(),
            ResultCount = items.Count
        }, ct);

        return Ok(PagedResult<ActionRequestDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// Actions this caller may actually approve.
    ///
    /// The caller's own requests are excluded here as well as refused at
    /// approval time. Hiding them is a courtesy to the console; the explicit
    /// check in the approve path is the rule.
    /// </summary>
    [HttpGet("pending-approval")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier2)]
    [ProducesResponseType(typeof(PagedResult<ActionRequestDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<ActionRequestDto>>> PendingApproval(
        [FromQuery] PagedQuery query, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;

        // Only actions whose minimum role this caller meets. Evaluated from
        // the in-code catalogue, so it cannot drift from the approval check.
        List<CabinetActionType> approvable = ActionCatalog.All
            .Where(e => actor.Role >= e.MinimumRole)
            .Select(e => e.Action)
            .ToList();

        IQueryable<ActionRequest> rows = BaseQuery()
            .Where(a => a.Status == ActionRequestStatus.PendingApproval &&
                        a.RequestedByUserId != actor.UserId &&
                        approvable.Contains(a.Action));

        int total = await rows.CountAsync(ct);

        List<ActionRequestDto> items = Materialise(await Project(rows)
            .OrderBy(r => r.Action.RequestedUtc)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .ToListAsync(ct));

        await WriteObservedAsync(
            AuditActions.ListPendingApproval, new { ResultCount = items.Count }, ct);

        return Ok(PagedResult<ActionRequestDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// Approves an action. The four-eyes rule — approver must not be the
    /// requester — is enforced inside the service with an explicit check.
    /// </summary>
    [HttpPost("{id:guid}/approve")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier2)]
    [ProducesResponseType(typeof(ActionRequestDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ActionRequestDto>> Approve(
        Guid id, [FromBody] ApproveActionRequest request, CancellationToken ct)
    {
        OperationResult<ActionRequest> result = await _actions.ApproveAsync(CurrentUser, id, request, ct);

        return result.Succeeded ? Ok(await LoadDtoAsync(id, ct)) : Problem(result);
    }

    [HttpPost("{id:guid}/deny")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier2)]
    [ProducesResponseType(typeof(ActionRequestDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ActionRequestDto>> Deny(
        Guid id, [FromBody] DenyActionRequest request, CancellationToken ct)
    {
        OperationResult<ActionRequest> result = await _actions.DenyAsync(CurrentUser, id, request, ct);

        return result.Succeeded ? Ok(await LoadDtoAsync(id, ct)) : Problem(result);
    }

    private IQueryable<ActionRequest> BaseQuery() => _db.ActionRequests.AsNoTracking();

    /// <summary>
    /// Rows as the database can hand them over: scalar columns plus the raw
    /// parameters JSON. Deserialising happens after materialisation, because a
    /// dictionary is not something a query provider can build.
    /// </summary>
    private sealed record ActionRow
    {
        public required ActionRequest Action { get; init; }
        public string? CabinetHostname { get; init; }
        public string? ClientName { get; init; }
        public string? SiteName { get; init; }
        public string? RequestedByDisplayName { get; init; }
        public string? ApprovedByDisplayName { get; init; }
    }

    private IQueryable<ActionRow> Project(IQueryable<ActionRequest> rows) =>
        from a in rows
        join c in _db.Cabinets.AsNoTracking() on a.CabinetId equals c.Id into cabinets
        from cabinet in cabinets.DefaultIfEmpty()
        join r in _db.Users.AsNoTracking() on a.RequestedByUserId equals r.Id into requesters
        from requester in requesters.DefaultIfEmpty()
        join ap in _db.Users.AsNoTracking() on a.ApprovedByUserId equals ap.Id into approvers
        from approver in approvers.DefaultIfEmpty()
        select new ActionRow
        {
            Action = a,
            CabinetHostname = cabinet != null ? cabinet.Hostname : null,
            ClientName = cabinet != null ? cabinet.ClientName : null,
            SiteName = cabinet != null ? cabinet.SiteName : null,
            RequestedByDisplayName = requester != null ? requester.DisplayName : null,
            ApprovedByDisplayName = approver != null ? approver.DisplayName : null
        };

    private static List<ActionRequestDto> Materialise(IEnumerable<ActionRow> rows) =>
        rows.Select(ToDto).ToList();

    private static ActionRequestDto ToDto(ActionRow row)
    {
        ActionRequest a = row.Action;

        return new ActionRequestDto
        {
            Id = a.Id,
            Action = a.Action,
            CabinetId = a.CabinetId,
            CabinetHostname = row.CabinetHostname ?? string.Empty,
            ClientName = row.ClientName ?? string.Empty,
            SiteName = row.SiteName ?? string.Empty,
            RequestedByUserId = a.RequestedByUserId,
            RequestedByDisplayName = row.RequestedByDisplayName ?? string.Empty,
            RequestedUtc = a.RequestedUtc,
            Reason = a.Reason,
            TicketReference = a.TicketReference,
            Status = a.Status,
            ApprovedByUserId = a.ApprovedByUserId,
            ApprovedByDisplayName = row.ApprovedByDisplayName,
            ApprovedUtc = a.ApprovedUtc,
            DispatchedUtc = a.DispatchedUtc,
            CompletedUtc = a.CompletedUtc,
            ResultStatus = a.ResultStatus,
            ResultOutput = a.ResultOutput,
            ExpiresUtc = a.ExpiresUtc,
            SafetyChecksOverridden = a.SafetyChecksOverridden,
            OverrideReason = a.OverrideReason,
            Parameters = Deserialise(a.ParametersJson)
        };
    }

    private async Task<ActionRequestDto?> LoadDtoAsync(Guid id, CancellationToken ct)
    {
        ActionRow? row = await Project(BaseQuery().Where(a => a.Id == id)).FirstOrDefaultAsync(ct);

        return row is null ? null : ToDto(row);
    }

    private static IReadOnlyDictionary<string, string> Deserialise(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return new Dictionary<string, string>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json, Contracts.Common.ContractJson.Default)
                   ?? new Dictionary<string, string>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>();
        }
    }

    private Task WriteObservedAsync(string action, object? details, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;

        return _audit.WriteAsync(new AuditRecord
        {
            Action = action,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = details
        }, ct);
    }
}
