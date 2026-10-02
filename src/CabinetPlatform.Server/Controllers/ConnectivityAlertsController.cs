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

    [HttpGet("site/{siteId:guid}/summary")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<ConnectivitySiteWorkloadDto>> SiteWorkload(Guid siteId, CancellationToken ct)
    {
        if (siteId == Guid.Empty) return BadRequest("A site ID is required.");
        var now = time.GetUtcNow();
        var counts = await db.ConnectivityAlerts.AsNoTracking()
            .Where(a => a.SourceCabinet!.SiteId == siteId && a.ReceivedUtc >= now.AddDays(-30))
            .GroupBy(a => a.Status).Select(g => new { Status = g.Key, Count = g.Count() }).ToArrayAsync(ct);
        int Count(string status) => counts.Where(c => c.Status == status).Sum(c => c.Count);
        return Ok(new ConnectivitySiteWorkloadDto
        {
            SiteId = siteId, AsOfUtc = now, Open = Count("Open"),
            Acknowledged = Count("Acknowledged"), Resolved = Count("Resolved")
        });
    }

    [HttpGet("{id:guid}/correlation")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<ConnectivityCorrelationDto>> Correlation(Guid id, CancellationToken ct)
    {
        var alert = await db.ConnectivityAlerts.AsNoTracking()
            .Where(a => a.Id == id && a.ReceivedUtc >= time.GetUtcNow().AddDays(-30))
            .Select(a => new { a.Id, a.SourceCabinetId, a.TargetCabinetId, a.EvidenceId, a.Status,
                SiteId = a.SourceCabinet!.SiteId, CurrentSyncCabinetId = a.SourceCabinet.Site!.SyncCabinetId })
            .SingleOrDefaultAsync(ct);
        if (alert is null) return NotFound();

        // Pin the accepted directed pair and verify serialized identity as well.
        // Never substitute a newer interval from the same link.
        var evidence = await db.ConnectivityEvidence.AsNoTracking()
            .Where(e => e.Id == alert.EvidenceId && e.SourceCabinetId == alert.SourceCabinetId &&
                e.TargetCabinetId == alert.TargetCabinetId)
            .Select(e => new { e.Id, e.FirstObservedUtc, e.ObservedUtc, e.ReceivedUtc, e.SummaryJson })
            .SingleOrDefaultAsync(ct);
        ConnectivityCorrelationIntervalDto? interval = null;
        if (evidence is not null)
        {
            ConnectivitySummary? summary;
            try { summary = JsonSerializer.Deserialize<ConnectivitySummary>(evidence.SummaryJson, ContractJson.Default); }
            catch (JsonException) { summary = null; }
            if (summary is not null && summary.Id == alert.EvidenceId &&
                summary.SourceCabinetId == alert.SourceCabinetId && summary.TargetCabinetId == alert.TargetCabinetId &&
                summary.FirstObservedUtc == evidence.FirstObservedUtc && summary.LastObservedUtc == evidence.ObservedUtc)
                interval = new ConnectivityCorrelationIntervalDto
                {
                    FirstObservedUtc = summary.FirstObservedUtc, LastObservedUtc = summary.LastObservedUtc,
                    ReceivedUtc = evidence.ReceivedUtc, SuccessCount = summary.SuccessCount,
                    FailureCount = summary.FailureCount, ErrorCount = summary.ErrorCount,
                    SourceFirewallCheck = summary.SourceFirewallCheck
                };
        }

        var contacts = await db.Cabinets.AsNoTracking()
            .Where(c => c.Id == alert.SourceCabinetId || c.Id == alert.TargetCabinetId)
            .Select(c => new ConnectivityCorrelationCabinetDto
            {
                CabinetId = c.Id, LastCheckInUtc = c.LastCheckInUtc,
                LatestHeartbeatCollectedAtUtc = db.Heartbeats.Where(h => h.CabinetId == c.Id)
                    .OrderByDescending(h => h.CollectedAtUtc).ThenByDescending(h => h.ReceivedUtc)
                    .Select(h => (DateTimeOffset?)h.CollectedAtUtc).FirstOrDefault(),
                LatestHeartbeatReceivedAtUtc = db.Heartbeats.Where(h => h.CabinetId == c.Id)
                    .OrderByDescending(h => h.CollectedAtUtc).ThenByDescending(h => h.ReceivedUtc)
                    .Select(h => (DateTimeOffset?)h.ReceivedUtc).FirstOrDefault()
            }).ToArrayAsync(ct);
        ConnectivityCorrelationCabinetDto Contact(Guid cabinetId) =>
            contacts.SingleOrDefault(c => c.CabinetId == cabinetId) ?? new() { CabinetId = cabinetId };
        await audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ViewConnectivity, EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success, ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(), CabinetId = alert.SourceCabinetId,
            Details = new { AlertId = alert.Id, alert.EvidenceId }
        }, ct);
        return Ok(new ConnectivityCorrelationDto
        {
            AlertId = alert.Id, SiteId = alert.SiteId, SourceCabinetId = alert.SourceCabinetId,
            TargetCabinetId = alert.TargetCabinetId, Status = alert.Status, EvidenceId = alert.EvidenceId,
            Interval = interval, IntervalClaim = interval is null ? "Retained interval unavailable" : null,
            Source = Contact(alert.SourceCabinetId), Target = Contact(alert.TargetCabinetId),
            CurrentSyncCabinetId = alert.CurrentSyncCabinetId,
            TargetIsCurrentSync = alert.CurrentSyncCabinetId == alert.TargetCabinetId,
            TopologyClaim = alert.CurrentSyncCabinetId is null
                ? "Current sync designation unknown; incident-time topology unknown"
                : alert.CurrentSyncCabinetId == alert.TargetCabinetId
                    ? "Target is current sync cabinet; incident-time role unknown"
                    : "Target is not current sync cabinet (current peer or changed designation); incident-time role unknown"
        });
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
            if (summary is null || summary.Id != a.EvidenceId || summary.SourceCabinetId != a.SourceCabinetId ||
                summary.TargetCabinetId != a.TargetCabinetId) return a;
            return a with { IncidentEvidence = summary, SourceFirewallCheck = summary.SourceFirewallCheck };
        }).ToArray();
        return Ok(PagedResult<ConnectivityAlertDto>.Create(items, query.Page, query.PageSize, total));
    }
}
