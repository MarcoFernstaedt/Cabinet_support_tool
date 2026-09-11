using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Controllers;

[Route("api/fleet")]
public sealed class FleetController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly AgentIngestOptions _ingestOptions;
    private readonly TimeProvider _timeProvider;

    public FleetController(
        SupportDbContext db,
        IAuditService audit,
        IOptions<AgentIngestOptions> ingestOptions,
        TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _ingestOptions = ingestOptions.Value;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// Health counts across the fleet, or one client or site.
    ///
    /// Reads one narrow row per cabinet — the projected columns of its newest
    /// check-in and nothing else — and folds them into counts in memory. No
    /// payload is deserialised, and the query is bounded by the filter rather
    /// than by paging, because a count of everything is the point.
    /// </summary>
    [HttpGet("health")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(FleetHealthSummary), StatusCodes.Status200OK)]
    public async Task<ActionResult<FleetHealthSummary>> Health(
        [FromQuery] FleetHealthQuery query, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        IQueryable<Domain.Cabinet> cabinets = _db.Cabinets.AsNoTracking();

        if (!string.IsNullOrWhiteSpace(query.ClientName))
        {
            string client = query.ClientName.Trim();
            cabinets = cabinets.Where(c => c.ClientName == client);
        }

        if (!string.IsNullOrWhiteSpace(query.SiteName))
        {
            string site = query.SiteName.Trim();
            cabinets = cabinets.Where(c => c.SiteName == site);
        }

        var rows = await cabinets
            .Select(c => new
            {
                c.IsActive,
                c.LastCheckInUtc,
                Latest = _db.CheckIns
                    .Where(ci => ci.CabinetId == c.Id)
                    .OrderByDescending(ci => ci.ReceivedUtc)
                    .Select(ci => new
                    {
                        ci.CpuPercent,
                        ci.RamUsedPercent,
                        ci.MinFreeDiskPercent,
                        ci.PendingUpdateCount,
                        ci.WorstDiskHealth
                    })
                    .FirstOrDefault()
            })
            .ToListAsync(ct);

        var summary = new FleetHealthSummary
        {
            TotalCabinets = rows.Count,
            Inactive = rows.Count(r => !r.IsActive),
            GeneratedUtc = nowUtc
        };

        foreach (var row in rows)
        {
            CabinetHealthStatus health = HealthEvaluator.Evaluate(
                row.IsActive,
                row.LastCheckInUtc,
                nowUtc,
                _ingestOptions.OfflineAfterMinutes,
                row.Latest?.CpuPercent,
                row.Latest?.RamUsedPercent,
                row.Latest?.MinFreeDiskPercent,
                row.Latest?.PendingUpdateCount,
                row.Latest?.WorstDiskHealth);

            switch (health)
            {
                case CabinetHealthStatus.Healthy: summary.Healthy++; break;
                case CabinetHealthStatus.Warning: summary.Warning++; break;
                case CabinetHealthStatus.Critical: summary.Critical++; break;
                case CabinetHealthStatus.Offline: summary.Offline++; break;
                default: summary.Unknown++; break;
            }
        }

        summary.PendingRegistrations = await _db.PendingRegistrations
            .AsNoTracking()
            .CountAsync(r => r.Status == RegistrationStatus.Pending, ct);

        summary.ActionsAwaitingApproval = await _db.ActionRequests
            .AsNoTracking()
            .CountAsync(a => a.Status == ActionRequestStatus.PendingApproval, ct);

        CurrentUser actor = CurrentUser;

        await _audit.WriteAsync(new AuditRecord
        {
            Action = AuditActions.ViewFleetHealth,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = new { query.ClientName, query.SiteName, summary.TotalCabinets }
        }, ct);

        return Ok(summary);
    }
}
