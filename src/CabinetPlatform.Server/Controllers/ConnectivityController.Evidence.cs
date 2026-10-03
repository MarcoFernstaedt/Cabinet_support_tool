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
        // Retained rows remain readable, but no new peer observations can enter the ledger.
        return StatusCode(410, "Cabinet-to-cabinet ICMP reporting is retired.");
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
