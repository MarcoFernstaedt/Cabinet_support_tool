using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Controllers;

/// <summary>
/// Reading the audit trail.
///
/// Read-only by construction: this controller exposes no write verb, and the
/// DbContext would refuse a modified or deleted audit row even if it did.
/// Supervisor only — the trail includes who was refused what, which is not
/// something every technician needs to browse.
/// </summary>
[Route("api/audit")]
public sealed class AuditController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly QueryLimitsOptions _queryLimits;
    private readonly TimeProvider _timeProvider;

    public AuditController(
        SupportDbContext db,
        IAuditService audit,
        IOptions<QueryLimitsOptions> queryLimits,
        TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _queryLimits = queryLimits.Value;
        _timeProvider = timeProvider;
    }

    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(PagedResult<AuditEntryDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<PagedResult<AuditEntryDto>>> Query(
        [FromQuery] AuditQuery query, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        DateTimeOffset to = query.ToUtc ?? nowUtc;
        DateTimeOffset from = query.FromUtc ?? to.AddDays(-_queryLimits.DefaultHistoryRangeDays);

        if (from >= to)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewAudit, "FromUtc was not earlier than ToUtc.", null, null, null, ct);
            return Problem("FromUtc must be earlier than ToUtc.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        if ((to - from).TotalDays > _queryLimits.MaxHistoryRangeDays)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ViewAudit, "Requested audit range exceeded the maximum.", null, null, null, ct);
            return Problem(
                $"The requested range exceeds the maximum of {_queryLimits.MaxHistoryRangeDays} days.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        IQueryable<AuditEntry> rows = _db.AuditEntries
            .AsNoTracking()
            .Where(a => a.TimestampUtc >= from && a.TimestampUtc <= to);

        if (query.CabinetId is { } cabinetId)
        {
            rows = rows.Where(a => a.CabinetId == cabinetId);
        }

        if (!string.IsNullOrWhiteSpace(query.ActorId))
        {
            string actorId = query.ActorId.Trim();
            rows = rows.Where(a => a.ActorId == actorId);
        }

        if (query.EventKind is { } kind)
        {
            rows = rows.Where(a => a.EventKind == kind);
        }

        if (query.Result is { } result)
        {
            rows = rows.Where(a => a.Result == result);
        }

        if (query.Event is { } auditEvent)
        {
            rows = rows.Where(a => a.Event == auditEvent);
        }

        if (query.Action is { } action)
        {
            rows = rows.Where(a => a.Action == action);
        }

        if (query.BatchId is { } batchId)
        {
            rows = rows.Where(a => a.BatchId == batchId);
        }

        int total = await rows.CountAsync(ct);

        List<AuditEntryDto> items = await rows
            .OrderByDescending(a => a.TimestampUtc)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .Select(a => new AuditEntryDto
            {
                Id = a.Id,
                TimestampUtc = a.TimestampUtc,
                ActorType = a.ActorType,
                ActorId = a.ActorId ?? string.Empty,
                ActorDisplayName = a.ActorDisplayName,
                EventKind = a.EventKind,
                Event = a.Event,
                Action = a.Action,
                CabinetId = a.CabinetId,
                CabinetHostname = a.CabinetHostname,
                TargetCabinetId = a.TargetCabinetId,
                TargetCabinetHostname = a.TargetCabinetHostname,
                BatchId = a.BatchId,
                Result = a.Result,
                Reason = a.Reason,
                TicketReference = a.TicketReference,
                ApprovedByUserId = a.ApprovedByUserId,
                Details = a.Details,
                CorrelationId = a.CorrelationId
            })
            .ToListAsync(ct);

        CurrentUser actor = CurrentUser;

        // Reading the trail is itself an event worth recording.
        await _audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ViewAudit,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = query.CabinetId,
            Details = new
            {
                From = from,
                To = to,
                query.CabinetId,
                query.ActorId,
                EventKind = query.EventKind?.ToString(),
                Result = query.Result?.ToString(),
                ResultCount = items.Count
            }
        }, ct);

        return Ok(PagedResult<AuditEntryDto>.Create(items, query.Page, query.PageSize, total));
    }
}
