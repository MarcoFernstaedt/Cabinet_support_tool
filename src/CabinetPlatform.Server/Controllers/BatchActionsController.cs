using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
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
/// Acting on several cabinets at once.
/// </summary>
/// <remarks>
/// A separate resource from single actions on purpose. A console looping over
/// <c>POST /api/actions</c> would present a Supervisor with fifty one-cabinet
/// decisions instead of one fifty-cabinet decision — the same information,
/// arranged so that nobody can weigh it.
/// </remarks>
[Route("api/batches")]
public sealed class BatchActionsController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IActionRequestService _actions;
    private readonly IAuditService _audit;

    /// <summary>Creates the controller.</summary>
    /// <param name="db">The database.</param>
    /// <param name="actions">The one path to creating and deciding actions.</param>
    /// <param name="audit">The audit trail.</param>
    public BatchActionsController(SupportDbContext db, IActionRequestService actions, IAuditService audit)
    {
        _db = db;
        _actions = actions;
        _audit = audit;
    }

    /// <summary>Requests one action across an explicit list of cabinets.</summary>
    /// <param name="request">The action, its parameters and its frozen targets.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost]
    [Authorize(Policy = AuthorizationPolicies.RequireTier2)]
    [ProducesResponseType(typeof(BatchActionView), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<BatchActionView>> Create(
        [FromBody] CreateBatchActionRequest request, CancellationToken ct)
    {
        OperationResult<BatchActionRequest> result = await _actions.CreateBatchAsync(CurrentUser, request, ct);

        if (!result.Succeeded)
        {
            return Problem(result);
        }

        BatchActionView view = await ProjectAsync(result.Value!.Id, ct)
                               ?? throw new InvalidOperationException("The created batch could not be read back.");

        return CreatedAtAction(nameof(GetById), new { id = view.Id }, view);
    }

    /// <summary>One batch, with every cabinet's own state.</summary>
    /// <param name="id">The batch.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(BatchActionView), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BatchActionView>> GetById(Guid id, CancellationToken ct)
    {
        BatchActionView? view = await ProjectAsync(id, ct);

        if (view is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewBatchAction, "Batch not found.", null, new { BatchId = id }, null, ct);
            return Problem("Batch not found.", statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        await _audit.WriteAsync(Observed(AuditEvent.ViewBatchAction, new { BatchId = id }, id), ct);

        return Ok(view);
    }

    /// <summary>The batch list.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(PagedResult<BatchActionView>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<BatchActionView>>> List(
        [FromQuery] BatchActionQuery query, CancellationToken ct)
    {
        IQueryable<BatchActionRequest> batches = _db.BatchActionRequests.AsNoTracking();

        if (query.Status is { } status)
        {
            batches = batches.Where(b => b.Status == status);
        }

        int total = await batches.CountAsync(ct);

        List<Guid> ids = await batches
            .OrderByDescending(b => b.RequestedUtc)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .Select(b => b.Id)
            .ToListAsync(ct);

        var items = new List<BatchActionView>(ids.Count);

        foreach (Guid id in ids)
        {
            BatchActionView? view = await ProjectAsync(id, ct);

            if (view is not null)
            {
                items.Add(view);
            }
        }

        await _audit.WriteAsync(
            Observed(AuditEvent.ViewBatchAction, new { ResultCount = items.Count }), ct);

        return Ok(PagedResult<BatchActionView>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// Approves a batch and expands it into one request per cabinet.
    /// </summary>
    /// <remarks>
    /// Each cabinet is judged on its own state as it expands: a cabinet with
    /// somebody signed in, an unreadable logged-on flag, or a closed
    /// maintenance window in its own zone is skipped and reported, never
    /// proceeded past.
    /// </remarks>
    /// <param name="id">The batch.</param>
    /// <param name="request">The approver's note.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("{id:guid}/approve")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier2)]
    [ProducesResponseType(typeof(BatchActionView), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<BatchActionView>> Approve(
        Guid id, [FromBody] ApproveActionRequest request, CancellationToken ct)
    {
        OperationResult<BatchActionRequest> result = await _actions.ApproveBatchAsync(CurrentUser, id, request, ct);

        return result.Succeeded ? Ok(await ProjectAsync(id, ct)) : Problem(result);
    }

    /// <summary>Refuses a batch. Nothing is expanded and nothing is dispatched.</summary>
    /// <param name="id">The batch.</param>
    /// <param name="request">Why.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("{id:guid}/deny")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier2)]
    [ProducesResponseType(typeof(BatchActionView), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<BatchActionView>> Deny(
        Guid id, [FromBody] DenyActionRequest request, CancellationToken ct)
    {
        OperationResult<BatchActionRequest> result = await _actions.DenyBatchAsync(CurrentUser, id, request, ct);

        return result.Succeeded ? Ok(await ProjectAsync(id, ct)) : Problem(result);
    }

    private async Task<BatchActionView?> ProjectAsync(Guid id, CancellationToken ct)
    {
        BatchActionRequest? batch = await _db.BatchActionRequests
            .AsNoTracking()
            .Include(b => b.Targets)
            .FirstOrDefaultAsync(b => b.Id == id, ct);

        if (batch is null)
        {
            return null;
        }

        List<Guid> cabinetIds = batch.Targets.Select(t => t.CabinetId).ToList();

        var cabinets = await _db.Cabinets
            .AsNoTracking()
            .Where(c => cabinetIds.Contains(c.Id))
            .Select(c => new { c.Id, c.Hostname, SiteName = c.Site!.Name })
            .ToListAsync(ct);

        List<Guid> actionIds = batch.Targets
            .Where(t => t.ActionRequestId is not null)
            .Select(t => t.ActionRequestId!.Value)
            .ToList();

        var actions = await _db.ActionRequests
            .AsNoTracking()
            .Where(a => actionIds.Contains(a.Id))
            .Select(a => new { a.Id, a.Status, a.ResultStatus })
            .ToListAsync(ct);

        var requester = await _db.Users.AsNoTracking()
            .Where(u => u.Id == batch.RequestedByUserId)
            .Select(u => u.DisplayName)
            .FirstOrDefaultAsync(ct);

        var approver = await _db.Users.AsNoTracking()
            .Where(u => u.Id == batch.ApprovedByUserId)
            .Select(u => u.DisplayName)
            .FirstOrDefaultAsync(ct);

        return new BatchActionView
        {
            Id = batch.Id,
            Action = batch.Action,
            RequestedByUserId = batch.RequestedByUserId,
            RequestedByDisplayName = requester,
            RequestedUtc = batch.RequestedUtc,
            Reason = batch.Reason,
            TicketReference = batch.TicketReference,
            Parameters = DeserialiseParameters(batch.ParametersJson),
            Status = batch.Status,
            ApprovedByUserId = batch.ApprovedByUserId,
            ApprovedByDisplayName = approver,
            ApprovedUtc = batch.ApprovedUtc,
            DenialReason = batch.DenialReason,
            TargetCount = batch.TargetCount,
            Targets = batch.Targets
                .Select(t =>
                {
                    var cabinet = cabinets.FirstOrDefault(c => c.Id == t.CabinetId);
                    var action = actions.FirstOrDefault(a => a.Id == t.ActionRequestId);

                    return new BatchActionTargetView
                    {
                        CabinetId = t.CabinetId,
                        CabinetHostname = cabinet?.Hostname,
                        SiteName = cabinet?.SiteName,
                        ActionRequestId = t.ActionRequestId,
                        Status = action?.Status,
                        ResultStatus = action?.ResultStatus,
                        SkippedReason = t.SkippedReason,
                    };
                })
                .OrderBy(t => t.CabinetHostname, StringComparer.OrdinalIgnoreCase)
                .ToList(),
        };
    }

    private static IReadOnlyDictionary<string, string> DeserialiseParameters(string json)
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

    private AuditRecord Observed(AuditEvent auditEvent, object details, Guid? batchId = null) => new()
    {
        Event = auditEvent,
        EventKind = AuditEventKind.Observed,
        Result = AuditResult.Success,
        ActorType = ActorType.User,
        ActorId = CurrentUser.UserId.ToString(),
        ActorDisplayName = CurrentUser.Username,
        BatchId = batchId,
        Details = details,
    };
}
