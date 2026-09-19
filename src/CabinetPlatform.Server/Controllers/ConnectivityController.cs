using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Opt-in office monitoring. No scanning, DNS, actions or cabinet mutation.</summary>
[Route("api/connectivity")]
public sealed partial class ConnectivityController(SupportDbContext db, IAuditService audit, TimeProvider time) : SupportControllerBase
{
    private static readonly JsonSerializerOptions Json = ContractJson.CreateOptions();

    [HttpPut("cabinets/{id:guid}/targets")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [RequestSizeLimit(8192)]
    public async Task<IActionResult> Configure(Guid id, ConfigureConnectivityRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Reason) || request.Reason.Length > 500 ||
            request.Targets is null || request.Targets.Count > ConnectivityLimits.MaximumTargets ||
            request.Targets.Any(t => t is null || t.CabinetId == id || !ConnectivityLimits.IsAllowedAddress(t.Address)) ||
            request.Targets.Select(t => t.CabinetId).Distinct().Count() != request.Targets.Count ||
            request.Targets.Select(t => t.Address).Distinct().Count() != request.Targets.Count)
            return BadRequest("Supply a reason and up to four unique registered private IPv4 targets.");

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        // Shares the cabinet write lock with ingestion and other configurations.
        if (await db.Cabinets.Where(c => c.Id == id && c.IsActive)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.LastCheckInUtc, c => c.LastCheckInUtc), ct) == 0)
            return NotFound();
        var source = await db.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == id, ct);
        var ids = request.Targets.Select(t => t.CabinetId).ToArray();
        var targets = await db.Cabinets.Where(c => ids.Contains(c.Id) && c.IsActive && c.SiteId == source.SiteId).ToListAsync(ct);
        if (targets.Count != ids.Length) return NotFound();
        // Role is authoritative server topology, never an agent or operator assertion.
        var approved = request.Targets.Select(t => t with { IsSync = t.CabinetId == source.Site!.SyncCabinetId }).ToArray();
        if (approved.Count(t => !t.IsSync) > 3) return BadRequest("At most three peers and one designated sync cabinet.");
        var row = await db.ConnectivityConfigurations.FindAsync([id], ct);
        var previous = row?.TargetsJson;
        if (row is null)
        {
            row = new ConnectivityConfiguration { SourceCabinetId = id };
            db.ConnectivityConfigurations.Add(row);
        }
        row.StatesJson = "[]";
        row.ConfigurationId = Guid.NewGuid();
        row.SiteId = source.SiteId;
        row.UpdatedUtc = time.GetUtcNow();
        row.TargetsJson = JsonSerializer.Serialize(approved, Json);
        audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.ConfigureConnectivity, EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success, ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(), CabinetId = id, Reason = request.Reason,
            Details = new { previous, row.TargetsJson, row.ConfigurationId }
        });
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return Ok(new { row.ConfigurationId });
    }

    [HttpGet("/api/agent/connectivity/plan")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName, Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    public async Task<ActionResult<ConnectivityPlan>> Plan(CancellationToken ct)
    {
        var source = await AgentSource(ct);
        if (source is null) return Forbid();
        var config = await db.ConnectivityConfigurations.AsNoTracking().SingleOrDefaultAsync(c => c.SourceCabinetId == source.Id, ct);
        var approved = config is null || config.SiteId != source.SiteId ? [] : await LiveTargets(config, source, ct);
        var now = time.GetUtcNow();
        return Ok(new ConnectivityPlan
        {
            ConfigurationId = config?.ConfigurationId ?? Guid.Empty, SourceCabinetId = source.Id,
            SiteId = source.SiteId, IssuedUtc = now, ExpiresUtc = now.AddMinutes(10), Targets = approved
        });
    }

    private Task<Cabinet?> AgentSource(CancellationToken ct)
    {
        var machine = User.FindFirst(AgentAuthenticationHandler.MachineIdClaimType)?.Value;
        return db.Cabinets.AsNoTracking().Include(c => c.Site).SingleOrDefaultAsync(c => c.MachineId == machine && c.IsActive, ct);
    }

    private async Task<ConnectivityTarget[]> LiveTargets(ConnectivityConfiguration config, Cabinet source, CancellationToken ct)
    {
        var targets = JsonSerializer.Deserialize<ConnectivityTarget[]>(config.TargetsJson, Json) ?? [];
        var ids = targets.Select(t => t.CabinetId).ToArray();
        var active = await db.Cabinets.Where(c => ids.Contains(c.Id) && c.IsActive && c.SiteId == source.SiteId)
            .Select(c => c.Id).ToArrayAsync(ct);
        return targets.Where(t => active.Contains(t.CabinetId) && t.IsSync == (t.CabinetId == source.Site!.SyncCabinetId)).ToArray();
    }
}
