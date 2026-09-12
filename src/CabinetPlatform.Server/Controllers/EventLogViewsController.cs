using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace CabinetPlatform.Server.Controllers;

/// <summary>
/// The shared, named event log views: everybody runs them, Supervisors define
/// them.
/// </summary>
/// <remarks>
/// <para>
/// The split is deliberate and is one of the few places role still decides
/// anything. Running a view reads one cabinet's logs and is ordinary support
/// work. Editing one changes what every rep sees on every cabinet, and a
/// narrowed filter that quietly stops showing the records people relied on
/// looks exactly like a healthy cabinet — which is the worst failure this
/// screen can have.
/// </para>
/// <para>
/// No endpoint here accepts a query expression. A view is a set of named
/// fields; the agent builds its own XPath from them.
/// </para>
/// </remarks>
[Route("api/event-log-views")]
public sealed class EventLogViewsController : SupportControllerBase
{
    private readonly IEventLogViewService _views;
    private readonly IAuditService _audit;

    /// <summary>Creates the controller.</summary>
    /// <param name="views">Reads and writes the stored views.</param>
    /// <param name="audit">The audit trail.</param>
    public EventLogViewsController(IEventLogViewService views, IAuditService audit)
    {
        _views = views;
        _audit = audit;
    }

    /// <summary>Lists the views a rep may run.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(PagedResult<EventLogViewDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<EventLogViewDto>>> List(
        [FromQuery] EventLogViewQuery query, CancellationToken ct)
    {
        PagedResult<EventLogViewDto> result = await _views.ListAsync(query, ct);

        await _audit.WriteAsync(Observed(AuditEvent.ListEventLogViews, new
        {
            query.Search,
            query.IncludeRetired,
            result.TotalCount,
        }), ct);

        return Ok(result);
    }

    /// <summary>Reads one view's definition.</summary>
    /// <param name="id">The view.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(EventLogViewDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<EventLogViewDto>> Get(Guid id, CancellationToken ct)
    {
        OperationResult<EventLogViewDto> result = await _views.GetAsync(id, ct);

        if (!result.Succeeded)
        {
            return Problem(result);
        }

        await _audit.WriteAsync(
            Observed(AuditEvent.ListEventLogViews, new { EventLogViewId = id }), ct);

        return Ok(result.Value);
    }

    /// <summary>Defines a new view.</summary>
    /// <param name="request">The definition and why it is being added.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(EventLogViewDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<EventLogViewDto>> Create(
        [FromBody] CreateEventLogViewRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            return Problem("A reason is required. Views are shared by every rep.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        OperationResult<EventLogViewDto> result = await _views.CreateAsync(CurrentUser, request, ct);

        return result.Succeeded
            ? CreatedAtAction(nameof(Get), new { id = result.Value!.Id }, result.Value)
            : Problem(result);
    }

    /// <summary>Replaces a view's definition in full.</summary>
    /// <param name="id">The view.</param>
    /// <param name="request">The complete new definition.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPut("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(EventLogViewDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<EventLogViewDto>> Update(
        Guid id, [FromBody] UpdateEventLogViewRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            return Problem("A reason is required. Views are shared by every rep.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        OperationResult<EventLogViewDto> result = await _views.UpdateAsync(CurrentUser, id, request, ct);

        return result.Succeeded ? Ok(result.Value) : Problem(result);
    }

    /// <summary>
    /// Retires a view so it stops being offered.
    /// </summary>
    /// <remarks>
    /// Retired, never deleted, and this is a POST rather than a DELETE for that
    /// reason: an action request from two years ago names this view by id, and
    /// a reviewer reading that request has to be able to see what it ran.
    /// </remarks>
    /// <param name="id">The view.</param>
    /// <param name="request">Why it is being retired.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("{id:guid}/retire")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(EventLogViewDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<EventLogViewDto>> Retire(
        Guid id, [FromBody] RetireEventLogViewRequest request, CancellationToken ct)
    {
        OperationResult<EventLogViewDto> result =
            await _views.RetireAsync(CurrentUser, id, request.Reason, request.TicketReference, ct);

        return result.Succeeded ? Ok(result.Value) : Problem(result);
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
