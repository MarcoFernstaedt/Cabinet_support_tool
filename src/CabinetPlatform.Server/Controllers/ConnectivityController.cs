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
using Microsoft.AspNetCore.DataProtection;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Opt-in office monitoring. No scanning, DNS, actions or cabinet mutation.</summary>
[Route("api/connectivity")]
public sealed partial class ConnectivityController(SupportDbContext db, IAuditService audit, TimeProvider time, IDataProtectionProvider protection) : SupportControllerBase
{
    private static readonly JsonSerializerOptions Json = ContractJson.CreateOptions();

    [HttpPut("cabinets/{id:guid}/targets")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [RequestSizeLimit(8192)]
    public IActionResult Configure(Guid id, ConfigureConnectivityRequest request, CancellationToken ct)
    {
        // Retired endpoint: never mutate historical configuration or issue new targets.
        return StatusCode(410, "Cabinet-to-cabinet ICMP configuration is retired.");
    }

    [HttpGet("/api/agent/connectivity/plan")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName, Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    public async Task<ActionResult<ConnectivityPlan>> Plan(CancellationToken ct)
    {
        var source = await AgentSource(ct);
        if (source is null) return Forbid();
        var now = time.GetUtcNow();
        return Ok(new ConnectivityPlan
        {
            ConfigurationId = Guid.Empty, SourceCabinetId = source.Id,
            SiteId = source.SiteId, IssuedUtc = now, ExpiresUtc = now.AddMinutes(10), Targets = []
        });
    }

    private Task<Cabinet?> AgentSource(CancellationToken ct)
    {
        var machine = User.FindFirst(AgentAuthenticationHandler.MachineIdClaimType)?.Value;
        return db.Cabinets.AsNoTracking().Include(c => c.Site).SingleOrDefaultAsync(c => c.MachineId == machine && c.IsActive, ct);
    }

    // Historical evidence validation only. Never use this list to issue new plans.
    private async Task<ConnectivityTarget[]> LiveTargets(ConnectivityConfiguration config, Cabinet source, CancellationToken ct)
    {
        var targets = JsonSerializer.Deserialize<ConnectivityTarget[]>(config.TargetsJson, Json) ?? [];
        var ids = targets.Select(t => t.CabinetId).ToArray();
        var active = await db.Cabinets.Where(c => ids.Contains(c.Id) && c.IsActive && c.SiteId == source.SiteId)
            .Select(c => c.Id).ToArrayAsync(ct);
        return targets.Where(t => active.Contains(t.CabinetId) && t.IsSync == (t.CabinetId == source.Site!.SyncCabinetId)).ToArray();
    }
}
