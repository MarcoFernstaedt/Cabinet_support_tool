using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Isolated, exact-grant read surface for the authenticated demo.</summary>
[Route("api/demo/cabinets")]
public sealed class DemoCabinetsController(SupportDbContext db, TimeProvider clock) : SupportControllerBase
{
    // The agent's routine heartbeat is nominally five minutes; three missed intervals
    // are stale. This is sample age, not last transport contact or an SLA.
    private static readonly TimeSpan PerformanceFreshness = TimeSpan.FromMinutes(15);

    [HttpGet("{id:guid}/performance")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<IActionResult> LatestPerformance(Guid id, CancellationToken ct)
    {
        var userId = CurrentUser.UserId;
        // Authorization is evaluated at each request against the live exact grant.
        // Do not infer entitlement from role, site, or the presence of a sample.
        var granted = await db.CabinetReadGrants.AsNoTracking().AnyAsync(g =>
            g.UserId == userId && g.CabinetId == id &&
            g.User!.IsActive && !g.User.MustChangePassword && g.Cabinet!.IsActive, ct);
        if (!granted) return NotFound();

        var sample = await db.Heartbeats.AsNoTracking()
            .Where(h => h.CabinetId == id && !h.IsAggregated)
            .OrderByDescending(h => h.CollectedAtUtc).ThenByDescending(h => h.ReceivedUtc)
            .Select(h => new { h.CollectedAtUtc, h.ReceivedUtc, h.CpuPercent, h.RamUsedPercent, h.MinFreeDiskPercent })
            .FirstOrDefaultAsync(ct);
        if (sample is null)
            return Ok(new DemoPerformance(id, "missing", null, null, null, null, null));

        var now = clock.GetUtcNow();
        static double? Percent(double? value) => value is >= 0 and <= 100 && double.IsFinite(value.Value) ? value : null;
        var cpu = Percent(sample.CpuPercent);
        var ram = Percent(sample.RamUsedPercent);
        var disk = Percent(sample.MinFreeDiskPercent);
        var state = sample.CollectedAtUtc > now || sample.ReceivedUtc < sample.CollectedAtUtc || sample.ReceivedUtc > now
            ? "unknown"
            : now - sample.CollectedAtUtc > PerformanceFreshness ? "stale"
            : cpu is null && ram is null && disk is null ? "unknown" : "current";
        return Ok(new DemoPerformance(id, state, sample.CollectedAtUtc, sample.ReceivedUtc, cpu, ram, disk));
    }

    private sealed record DemoPerformance(Guid CabinetId, string State, DateTimeOffset? CollectedAtUtc,
        DateTimeOffset? ReceivedUtc, double? CpuPercent, double? RamUsedPercent, double? MinFreeDiskPercent);
    [HttpGet("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<IActionResult> Detail(Guid id, CancellationToken ct)
    {
        Guid userId = CurrentUser.UserId;
        // Keep grant, user and cabinet eligibility in the same live query. Neither
        // a role nor a site's sync designation supplies an implicit grant.
        var detail = await db.CabinetReadGrants.AsNoTracking()
            .Where(g => g.UserId == userId && g.CabinetId == id &&
                g.User!.IsActive && !g.User.MustChangePassword && g.Cabinet!.IsActive)
            .Select(g => new
            {
                CabinetId = g.CabinetId,
                g.Cabinet!.Hostname,
                g.Cabinet.FriendlyName,
                SiteName = g.Cabinet.Site!.Name,
                ClientName = g.Cabinet.Site.Client!.Name
            })
            .SingleOrDefaultAsync(ct);
        return detail is null ? NotFound() : Ok(detail);
    }
}
