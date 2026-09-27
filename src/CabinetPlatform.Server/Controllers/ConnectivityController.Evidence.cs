using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

public sealed partial class ConnectivityController
{
    [HttpPost("/api/agent/connectivity/summaries")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName, Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [RequestSizeLimit(32768)]
    public async Task<IActionResult> Report(IReadOnlyList<ConnectivitySummary> summaries, CancellationToken ct)
    {
        var source = await AgentSource(ct);
        if (source is null) return Forbid();
        var now = time.GetUtcNow();
        if (summaries is null || summaries.Count is < 1 or > 16 ||
            summaries.Any(s => s is null || s.SourceCabinetId != source.Id || !ConnectivityClassifier.IsValid(s, now)) ||
            summaries.Select(s => s.Id).Distinct().Count() != summaries.Count) return BadRequest("Invalid bounded interval evidence.");

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        await db.Cabinets.Where(c => c.Id == source.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.LastCheckInUtc, c => c.LastCheckInUtc), ct);
        source = await AgentSource(ct);
        if (source is null) return Forbid();
        var config = await db.ConnectivityConfigurations.SingleOrDefaultAsync(c => c.SourceCabinetId == source.Id, ct);
        if (config is null || config.SiteId != source.SiteId) return Conflict("Connectivity configuration changed.");
        var targets = await LiveTargets(config, source, ct);
        if (summaries.Any(s => s.ConfigurationId != config.ConfigurationId || targets.All(t => t.CabinetId != s.TargetCabinetId)))
            return Conflict("Connectivity configuration changed.");
        var states = JsonSerializer.Deserialize<ConnectivityLinkState[]>(config.StatesJson, Json)!.ToDictionary(s => s.TargetCabinetId);
        foreach (var summary in summaries.OrderBy(s => s.FirstObservedUtc))
        {
            var json = JsonSerializer.Serialize(summary, Json);
            var existing = await db.ConnectivityEvidence.AsNoTracking().SingleOrDefaultAsync(e => e.SourceCabinetId == source.Id && e.Id == summary.Id, ct);
            if (existing is not null)
            {
                if (existing.SummaryJson != json) return Conflict("Summary identity already used for different evidence.");
                continue;
            }
            // Do not count overlapping/reissued windows twice. Reject ambiguous evidence,
            // leaving the complete batch transactional and retryable.
            if (await db.ConnectivityEvidence.AnyAsync(e => e.SourceCabinetId == source.Id &&
                e.TargetCabinetId == summary.TargetCabinetId && e.ConfigurationId == summary.ConfigurationId &&
                e.FirstObservedUtc <= summary.LastObservedUtc && e.ObservedUtc >= summary.FirstObservedUtc, ct))
                return Conflict("Observation windows overlap.");
            if (db.ConnectivityEvidence.Local.Any(e => e.TargetCabinetId == summary.TargetCabinetId &&
                e.FirstObservedUtc <= summary.LastObservedUtc && e.ObservedUtc >= summary.FirstObservedUtc))
                return Conflict("Observation windows overlap.");
            db.ConnectivityEvidence.Add(new ConnectivityEvidence
            {
                Id = summary.Id, SourceCabinetId = source.Id, TargetCabinetId = summary.TargetCabinetId,
                ConfigurationId = summary.ConfigurationId, FirstObservedUtc = summary.FirstObservedUtc,
                ObservedUtc = summary.LastObservedUtc, ReceivedUtc = now, SummaryJson = json
            });
            var previous = states.GetValueOrDefault(summary.TargetCabinetId) ?? new ConnectivityLinkState
            {
                TargetCabinetId = summary.TargetCabinetId,
                IsSync = targets.Single(t => t.CabinetId == summary.TargetCabinetId).IsSync
            };
            var current = ConnectivityClassifier.Apply(previous, summary, now);
            states[summary.TargetCabinetId] = current;
            if (current.IncidentReceivedUtc is not null &&
                (current.IncidentReceivedUtc != previous.IncidentReceivedUtc ||
                 current.IncidentObservedUtc != previous.IncidentObservedUtc ||
                 (previous.RecoveredObservedUtc is not null && current.RecoveredObservedUtc is null)))
            {
                db.ConnectivityAlerts.Add(new ConnectivityAlert
                {
                    SourceCabinetId = source.Id, TargetCabinetId = summary.TargetCabinetId,
                    EvidenceId = summary.Id, ObservedUtc = current.IncidentObservedUtc,
                    ReceivedUtc = current.IncidentReceivedUtc.Value
                });
            }
        }
        config.StatesJson = JsonSerializer.Serialize(states.Values, Json);
        await db.SaveChangesAsync(ct);
        // Queue annotations are retained for 30 days and at most 200 per source,
        // including unresolved rows. This is not a permanent incident archive.
        await db.ConnectivityAlerts.Where(a => a.SourceCabinetId == source.Id && a.ReceivedUtc < now.AddDays(-30)).ExecuteDeleteAsync(ct);
        var alertOverflow = db.ConnectivityAlerts.Where(a => a.SourceCabinetId == source.Id)
            .OrderByDescending(a => a.ReceivedUtc).ThenBy(a => a.Id).Skip(200).Select(a => a.Id);
        await db.ConnectivityAlerts.Where(a => a.SourceCabinetId == source.Id && alertOverflow.Contains(a.Id)).ExecuteDeleteAsync(ct);
        // Fixed per-source retention, not an unbounded successful-ping event history.
        await db.ConnectivityEvidence.Where(e => e.SourceCabinetId == source.Id && e.ObservedUtc < now.AddDays(-14)).ExecuteDeleteAsync(ct);
        var overflow = db.ConnectivityEvidence.Where(e => e.SourceCabinetId == source.Id)
            .OrderByDescending(e => e.ObservedUtc).ThenBy(e => e.Id).Skip(27000).Select(e => e.Id);
        await db.ConnectivityEvidence.Where(e => e.SourceCabinetId == source.Id && overflow.Contains(e.Id)).ExecuteDeleteAsync(ct);
        await transaction.CommitAsync(ct);
        return Ok();
    }

    [HttpGet("cabinets/{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<ConnectivityStatusDto>> Status(Guid id, CancellationToken ct)
    {
        var source = await db.Cabinets.AsNoTracking().Include(c => c.Site).SingleOrDefaultAsync(c => c.Id == id, ct);
        if (source is null) return NotFound();
        var config = await db.ConnectivityConfigurations.AsNoTracking().SingleOrDefaultAsync(c => c.SourceCabinetId == id, ct);
        var states = config is null ? [] : JsonSerializer.Deserialize<ConnectivityLinkState[]>(config.StatesJson, Json)!;
        var targets = config is null || config.SiteId != source.SiteId || !source.IsActive ? [] : await LiveTargets(config, source, ct);
        var now = time.GetUtcNow();
        var links = targets.Select(t => (states.SingleOrDefault(s => s.TargetCabinetId == t.CabinetId) ??
            new ConnectivityLinkState { TargetCabinetId = t.CabinetId, IsSync = t.IsSync })).Select(s => s with
            { IsStale = s.ObservedUtc is null || s.ObservedUtc < now.AddMinutes(-5) || s.ObservedUtc > now }).ToArray();
        var evidence = await db.ConnectivityEvidence.AsNoTracking().Where(e => e.SourceCabinetId == id)
            .OrderByDescending(e => e.ObservedUtc).ThenBy(e => e.Id).Take(40).ToArrayAsync(ct);
        await audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ViewConnectivity, EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success, ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(), CabinetId = id
        }, ct);
        return Ok(new ConnectivityStatusDto
        {
            SourceCabinetId = id, Links = links,
            RecentEvidence = evidence.Select(e => new ConnectivityEvidenceDto(JsonSerializer.Deserialize<ConnectivitySummary>(e.SummaryJson, Json)!, e.ReceivedUtc)).ToArray()
        });
    }
}
