using CabinetPlatform.Contracts.Common;
using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

[Route("api/connectivity-alerts")]
public sealed class ConnectivityAlertsController(SupportDbContext db, TimeProvider time, IAuditService audit) : SupportControllerBase
{
    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<PagedResult<ConnectivityAlertDto>>> List([FromQuery] ConnectivityAlertQuery query, CancellationToken ct)
    {
        return await ListCore(query, ct);
    }

    [HttpPost("{id:guid}/acknowledge")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public Task<IActionResult> Acknowledge(Guid id, AnnotateConnectivityAlertRequest request, CancellationToken ct) =>
        Annotate(id, request, "Open", "Acknowledged", AuditEvent.AcknowledgeConnectivityAlert, ct);

    [HttpPost("{id:guid}/resolve")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public Task<IActionResult> Resolve(Guid id, AnnotateConnectivityAlertRequest request, CancellationToken ct) =>
        Annotate(id, request, "Acknowledged", "Resolved", AuditEvent.ResolveConnectivityAlert, ct);

    private async Task<IActionResult> Annotate(Guid id, AnnotateConnectivityAlertRequest request,
        string expected, string next, AuditEvent auditEvent, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var rows = db.ConnectivityAlerts.Where(a => a.Id == id && a.SourceCabinetId == request.SourceCabinetId && a.ReceivedUtc >= now.AddDays(-30));
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        if (!await rows.AnyAsync(ct)) return NotFound();
        int changed = await rows.Where(a => a.Status == expected).ExecuteUpdateAsync(set => set
            .SetProperty(a => a.Status, next).SetProperty(a => a.Note, request.Note.Trim())
            .SetProperty(a => a.UpdatedUtc, now).SetProperty(a => a.UpdatedByUserId, CurrentUser.UserId), ct);
        if (changed != 1) return Conflict("Alert state changed. Refresh the queue before deciding again.");
        audit.Enqueue(new AuditRecord
        {
            Event = auditEvent, EventKind = AuditEventKind.Caused, Result = AuditResult.Success,
            ActorType = ActorType.User, ActorId = CurrentUser.UserId.ToString(), ActorDisplayName = CurrentUser.Username,
            CabinetId = request.SourceCabinetId, Reason = request.Note.Trim(), Details = new { AlertId = id, Previous = expected, Status = next }
        });
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return NoContent();
    }

    private async Task<ActionResult<PagedResult<ConnectivityAlertDto>>> ListCore(ConnectivityAlertQuery query, CancellationToken ct)
    {
        var cutoff = time.GetUtcNow().AddDays(-30);
        var rows = db.ConnectivityAlerts.AsNoTracking().Where(a => a.ReceivedUtc >= cutoff);
        if (query.SiteId is { } site) rows = rows.Where(a => a.SourceCabinet!.SiteId == site);
        if (query.SourceCabinetId is { } source) rows = rows.Where(a => a.SourceCabinetId == source);
        if (!query.IncludeResolved) rows = rows.Where(a => a.Status != "Resolved");
        int total = await rows.CountAsync(ct);
        var items = await rows.OrderByDescending(a => a.ReceivedUtc).ThenBy(a => a.Id).Skip(query.Skip).Take(query.PageSize)
            .Select(a => new ConnectivityAlertDto
            {
                Id = a.Id, SourceCabinetId = a.SourceCabinetId, TargetCabinetId = a.TargetCabinetId,
                SiteId = a.SourceCabinet!.SiteId,
                EvidenceId = a.EvidenceId, ObservedUtc = a.ObservedUtc, ReceivedUtc = a.ReceivedUtc,
                Status = a.Status, Note = a.Note, UpdatedUtc = a.UpdatedUtc,
                SourceName = a.SourceCabinet!.FriendlyName ?? a.SourceCabinet.Hostname,
                SiteName = a.SourceCabinet.Site!.Name, ClientName = a.SourceCabinet.Site.Client!.Name
            }).ToArrayAsync(ct);
        var evidenceIds = items.Select(a => a.EvidenceId).ToArray();
        var snapshots = await db.ConnectivityEvidence.AsNoTracking()
            .Where(e => evidenceIds.Contains(e.Id))
            .Select(e => new { e.Id, e.SourceCabinetId, e.SummaryJson }).ToArrayAsync(ct);
        var byEvidence = snapshots.ToDictionary(e => (e.Id, e.SourceCabinetId));
        items = items.Select(a =>
        {
            if (!byEvidence.TryGetValue((a.EvidenceId, a.SourceCabinetId), out var evidence)) return a;
            var summary = JsonSerializer.Deserialize<ConnectivitySummary>(evidence.SummaryJson, ContractJson.Default);
            return a with { SourceFirewallCheck = summary?.SourceFirewallCheck };
        }).ToArray();
        return Ok(PagedResult<ConnectivityAlertDto>.Create(items, query.Page, query.PageSize, total));
    }
}
