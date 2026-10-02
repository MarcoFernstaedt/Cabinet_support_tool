using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
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

/// <summary>Requesting, approving and reading actions, singly and in batches.</summary>
[Route("api/actions")]
public sealed class ActionsController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IActionRequestService _actions;
    private readonly IAuditService _audit;

    /// <summary>Creates the controller.</summary>
    /// <param name="db">The database.</param>
    /// <param name="actions">The one path to creating and deciding actions.</param>
    /// <param name="audit">The audit trail.</param>
    public ActionsController(SupportDbContext db, IActionRequestService actions, IAuditService audit)
    {
        _db = db;
        _actions = actions;
        _audit = audit;
    }

    /// <summary>
    /// The catalog, as the server describes it.
    /// </summary>
    /// <remarks>
    /// The console uses it to label and disable buttons. The server enforces
    /// every rule in it regardless, so nothing here is a permission.
    /// </remarks>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("catalog")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(IReadOnlyList<ActionCatalogEntryDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ActionCatalogEntryDto>>> Catalog(CancellationToken ct)
    {
        List<ActionCatalogEntryDto> entries = ActionCatalog.Available(
                HttpContext.RequestServices.GetRequiredService<Microsoft.Extensions.Options.IOptions<
                    Configuration.ActionOptions>>().Value)
            .OrderBy(e => e.Action)
            .Select(e => new ActionCatalogEntryDto
            {
                Action = e.Action,
                DisplayName = e.DisplayName,
                Description = e.Description,
                MinimumRole = e.MinimumRole,
                RequiresApproval = e.RequiresApproval,
                IsDisruptive = e.IsDisruptive,
                TimeoutSeconds = e.TimeoutSeconds,
                AllowedParameterKeys = e.AllowedParameterKeys.OrderBy(k => k).ToArray(),
                AllowedPorts = e.AllowedPorts.OrderBy(p => p).ToArray(),
                MaintenanceWindowOnly = e.MaintenanceWindowOnly,
                BlockedIfUserLoggedOn = e.BlockedIfUserLoggedOn,
                TargetsAnotherCabinet = e.TargetsAnotherCabinet,
                Batchable = e.Batchable,
                BatchSupervisorThreshold = e.Batchable ? e.BatchSupervisorThreshold : null,
                MaximumBatchSize = e.Batchable ? e.MaximumBatchSize : null,
            })
            .ToList();

        await _audit.WriteAsync(Observed(AuditEvent.ViewActionCatalog, new { Count = entries.Count }), ct);

        return Ok(entries);
    }

    /// <summary>Requests one action on one cabinet.</summary>
    /// <param name="request">What to do and why.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ActionRequestView), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ActionRequestView>> Create(
        [FromBody] CreateActionRequest request, CancellationToken ct)
    {
        OperationResult<ActionRequest> result = await _actions.CreateAsync(CurrentUser, request, ct);

        if (!result.Succeeded)
        {
            return Problem(result);
        }

        ActionRequestView view = await ProjectAsync(result.Value!.Id, ct)
                                 ?? throw new InvalidOperationException("The created action could not be read back.");

        return CreatedAtAction(nameof(GetById), new { id = view.Id }, view);
    }

    /// <summary>
    /// Tests a cabinet's link to its site's sync cabinet, in one call.
    /// </summary>
    /// <remarks>
    /// This is the common case by a wide margin — "is this satellite talking to
    /// its sync cabinet?" — so the console offers it as one button and the
    /// server resolves the target rather than making a rep pick it from a list
    /// and get it wrong.
    /// </remarks>
    /// <param name="id">The source cabinet.</param>
    /// <param name="request">Why, and against which ticket.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("cabinets/{id:guid}/test-sync-link")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ActionRequestView), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ActionRequestView>> TestSyncLink(
        Guid id, [FromBody] TestSyncLinkRequest request, CancellationToken ct)
    {
        Domain.Cabinet? cabinet = await _db.Cabinets
            .AsNoTracking()
            .Include(c => c.Site)
            .FirstOrDefaultAsync(c => c.Id == id, ct);

        if (cabinet?.Site is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.CabinetLinkTest, "Cabinet not found.", id, null, ActionName.PingCabinet, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (cabinet.Site.SyncCabinetId is not { } syncId)
        {
            return Problem(
                "This cabinet's site has no sync cabinet, so there is no link to test. Standalone sites " +
                "are normal and are not an error.",
                statusCode: StatusCodes.Status409Conflict,
                title: "Conflict");
        }

        if (syncId == cabinet.Id)
        {
            return Problem(
                "This cabinet is its site's sync cabinet. Test the link from one of its satellites instead.",
                statusCode: StatusCodes.Status409Conflict,
                title: "Conflict");
        }

        var create = new CreateActionRequest
        {
            Action = ActionName.PingCabinet,
            CabinetId = cabinet.Id,
            Parameters = new Dictionary<string, string>
            {
                [ActionCatalog.TargetCabinetIdKey] = syncId.ToString(),
            },
            Reason = string.IsNullOrWhiteSpace(request.Reason)
                ? "Testing this cabinet's link to its site's sync cabinet."
                : request.Reason.Trim(),
            TicketReference = request.TicketReference,
        };

        OperationResult<ActionRequest> result = await _actions.CreateAsync(CurrentUser, create, ct);

        if (!result.Succeeded)
        {
            return Problem(result);
        }

        ActionRequestView view = await ProjectAsync(result.Value!.Id, ct)
                                 ?? throw new InvalidOperationException("The created action could not be read back.");

        return CreatedAtAction(nameof(GetById), new { id = view.Id }, view);
    }

    /// <summary>One action, with its whole lifecycle.</summary>
    /// <param name="id">The action.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ActionRequestView), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ActionRequestView>> GetById(Guid id, CancellationToken ct)
    {
        ActionRequestView? view = await ProjectAsync(id, ct);

        if (view is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ListActions, "Action request not found.", null, new { ActionRequestId = id }, null, ct);
            return Problem("Action request not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        return Ok(view);
    }

    /// <summary>The action list.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<ActionRequestView>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<ActionRequestView>>> List(
        [FromQuery] ActionQuery query, CancellationToken ct)
    {
        IQueryable<ActionRequest> actions = _db.ActionRequests.AsNoTracking();

        if (query.CabinetId is { } cabinetId)
        {
            actions = actions.Where(a => a.CabinetId == cabinetId);
        }

        if (query.Status is { } status)
        {
            actions = actions.Where(a => a.Status == status);
        }

        if (query.BatchId is { } batchId)
        {
            actions = actions.Where(a => a.BatchId == batchId);
        }

        int total = await actions.CountAsync(ct);

        List<ActionRequestView> items = await ProjectAsync(
            actions.OrderByDescending(a => a.RequestedUtc).Skip(query.Skip).Take(query.PageSize), ct);

        await _audit.WriteAsync(Observed(AuditEvent.ListActions, new
        {
            query.CabinetId,
            Status = query.Status?.ToString(),
            ResultCount = items.Count,
        }), ct);

        return Ok(PagedResult<ActionRequestView>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// Actions this caller is eligible to approve.
    /// </summary>
    /// <remarks>
    /// The caller's own requests are excluded here, because the four-eyes rule
    /// means they can never approve them. The server enforces that separately
    /// at approval time; this list exists so the console does not offer an
    /// action it is about to refuse.
    /// </remarks>
    /// <param name="query">Page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("pending-approval")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<ActionRequestView>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<ActionRequestView>>> PendingApproval(
        [FromQuery] PagedQuery query, CancellationToken ct)
    {
        Guid callerId = CurrentUser.UserId;

        IQueryable<ActionRequest> actions = _db.ActionRequests.AsNoTracking()
            .Where(a => a.Status == ActionRequestStatus.PendingApproval && a.RequestedByUserId != callerId);

        int total = await actions.CountAsync(ct);

        List<ActionRequestView> items = await ProjectAsync(
            actions.OrderBy(a => a.RequestedUtc).Skip(query.Skip).Take(query.PageSize), ct);

        await _audit.WriteAsync(
            Observed(AuditEvent.ListPendingApproval, new { ResultCount = items.Count }), ct);

        return Ok(PagedResult<ActionRequestView>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>Approves one action.</summary>
    /// <param name="id">The action.</param>
    /// <param name="request">The approver's note.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("{id:guid}/approve")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ActionRequestView), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ActionRequestView>> Approve(
        Guid id, [FromBody] ApproveActionRequest request, CancellationToken ct)
    {
        OperationResult<ActionRequest> result = await _actions.ApproveAsync(CurrentUser, id, request, ct);

        return result.Succeeded
            ? Ok(await ProjectAsync(id, ct))
            : Problem(result);
    }

    /// <summary>Refuses one action.</summary>
    /// <param name="id">The action.</param>
    /// <param name="request">Why.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("{id:guid}/deny")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ActionRequestView), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ActionRequestView>> Deny(
        Guid id, [FromBody] DenyActionRequest request, CancellationToken ct)
    {
        OperationResult<ActionRequest> result = await _actions.DenyAsync(CurrentUser, id, request, ct);

        return result.Succeeded
            ? Ok(await ProjectAsync(id, ct))
            : Problem(result);
    }

    private async Task<ActionRequestView?> ProjectAsync(Guid id, CancellationToken ct)
    {
        List<ActionRequestView> rows =
            await ProjectAsync(_db.ActionRequests.AsNoTracking().Where(a => a.Id == id), ct);

        return rows.FirstOrDefault();
    }

    /// <summary>
    /// Projects action rows with the names a person needs, resolved in one
    /// round trip rather than one per row.
    /// </summary>
    private async Task<List<ActionRequestView>> ProjectAsync(
        IQueryable<ActionRequest> actions, CancellationToken ct)
    {
        var rows = await actions
            .Select(a => new
            {
                Action = a,
                CabinetHostname = a.Cabinet!.Hostname,
                SiteName = a.Cabinet!.Site!.Name,
                SiteId = a.Cabinet!.SiteId,
                ClientName = a.Cabinet!.Site!.Client!.Name,
                Department = a.Cabinet!.DepartmentName,
                CabinetRole = a.Cabinet!.Role,
                SerialNumber = a.Cabinet!.SerialNumber,
                TargetHostname = _db.Cabinets
                    .Where(c => c.Id == a.TargetCabinetId)
                    .Select(c => c.Hostname)
                    .FirstOrDefault(),
                Target = _db.Cabinets
                    .Where(c => c.Id == a.TargetCabinetId)
                    .Select(c => new
                    {
                        c.Id,
                        c.Hostname,
                        c.SiteId,
                        SiteName = c.Site!.Name,
                        ClientName = c.Site!.Client!.Name,
                        c.DepartmentName,
                        c.Role,
                        c.SerialNumber,
                    })
                    .FirstOrDefault(),
                RequestedByDisplayName = _db.Users
                    .Where(u => u.Id == a.RequestedByUserId)
                    .Select(u => u.DisplayName)
                    .FirstOrDefault(),
                ApprovedByDisplayName = _db.Users
                    .Where(u => u.Id == a.ApprovedByUserId)
                    .Select(u => u.DisplayName)
                    .FirstOrDefault(),
            })
            .ToListAsync(ct);

        return rows.Select(r => new ActionRequestView
        {
            Id = r.Action.Id,
            Action = r.Action.Action,
            CabinetId = r.Action.CabinetId,
            CabinetHostname = r.CabinetHostname,
            ClientName = r.ClientName,
            SiteName = r.SiteName,

            // The full path travels with every action. An approver did not
            // raise the request and has no other context for it, so the one
            // thing they must be able to read off the row is exactly whose
            // cabinet they are about to authorise work on. A hostname alone
            // would not tell them: hostnames repeat across clients.
            CabinetPath = new CabinetPath
            {
                CabinetId = r.Action.CabinetId,
                ClientName = r.ClientName,
                SiteName = r.SiteName,
                SiteId = r.SiteId,
                DepartmentName = r.Department,
                CabinetName = r.CabinetHostname,
                Role = r.CabinetRole,
                SerialNumber = r.SerialNumber,
            },
            RequestedByUserId = r.Action.RequestedByUserId,
            RequestedByDisplayName = r.RequestedByDisplayName,
            RequestedUtc = r.Action.RequestedUtc,
            Parameters = DeserialiseParameters(r.Action.ParametersJson),
            TargetCabinetId = r.Action.TargetCabinetId,
            TargetCabinetHostname = r.TargetHostname,
            TargetCabinetPath = r.Target is null
                ? null
                : new CabinetPath
                {
                    CabinetId = r.Target.Id,
                    ClientName = r.Target.ClientName,
                    SiteName = r.Target.SiteName,
                    SiteId = r.Target.SiteId,
                    DepartmentName = r.Target.DepartmentName,
                    CabinetName = r.Target.Hostname,
                    Role = r.Target.Role,
                    SerialNumber = r.Target.SerialNumber,
                },
            Reason = r.Action.Reason,
            TicketReference = r.Action.TicketReference,
            Status = r.Action.Status,
            ApprovedByUserId = r.Action.ApprovedByUserId,
            ApprovedByDisplayName = r.ApprovedByDisplayName,
            ApprovedUtc = r.Action.ApprovedUtc,
            DispatchedUtc = r.Action.DispatchedUtc,
            CompletedUtc = r.Action.CompletedUtc,
            ResultStatus = r.Action.ResultStatus,
            ResultOutput = r.Action.Action is ActionName.GetWerMetadata or ActionName.GetHistoricalProcessEvidence ? null : r.Action.ResultOutput,
            CollectedData = r.Action.Action is ActionName.GetWerMetadata or ActionName.GetHistoricalProcessEvidence ? null : r.Action.CollectedDataJson,
            ExpiresUtc = r.Action.ExpiresUtc,
            SafetyChecksOverridden = r.Action.SafetyChecksOverridden,
            OverrideReason = r.Action.OverrideReason,
            BatchId = r.Action.BatchId,

            // Reserved for hardware actuation and always null in this build.
            // Carried so that the shape a future actuation feature has to fit
            // is already visible to whoever designs it.
            OnSiteConfirmedByUserId = r.Action.OnSiteConfirmedByUserId,
            OnSiteConfirmedUtc = r.Action.OnSiteConfirmedUtc,
        }).ToList();
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

    private AuditRecord Observed(AuditEvent auditEvent, object details) => new()
    {
        Event = auditEvent,
        EventKind = AuditEventKind.Observed,
        Result = AuditResult.Success,
        ActorType = ActorType.User,
        ActorId = CurrentUser.UserId.ToString(),
        ActorDisplayName = CurrentUser.Username,
        Details = details,
    };
}
