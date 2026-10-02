using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Services;

/// <summary>
/// Builds the fleet's read models from projected columns.
/// </summary>
/// <remarks>
/// <para>
/// One place, shared by the cabinet list, the site views and the fleet
/// summary, so that "healthy" cannot mean two different things on two screens.
/// </para>
/// <para>
/// Nothing here deserialises a stored document. Every value comes from a typed
/// column on <see cref="Heartbeat"/> or <see cref="Cabinet"/>, because these
/// queries run across the whole fleet and a list endpoint that opens payloads
/// stops working somewhere between the pilot and the rollout.
/// </para>
/// </remarks>
public interface ICabinetProjection
{
    IQueryable<Cabinet> FilterByHealth(IQueryable<Cabinet> cabinets, CabinetHealthStatus health, DateTimeOffset nowUtc);

    /// <summary>
    /// Projects a page of cabinets, newest heartbeat per cabinet, in one round
    /// trip.
    /// </summary>
    /// <param name="cabinets">The already-filtered, already-paged query.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="ct">Cancels the query.</param>
    Task<List<CabinetSummary>> ProjectAsync(
        IQueryable<Cabinet> cabinets, DateTimeOffset nowUtc, CancellationToken ct);
}

/// <inheritdoc />
public sealed class CabinetProjection : ICabinetProjection
{
    private readonly SupportDbContext _db;
    private readonly AgentIngestOptions _ingest;

    /// <summary>Creates the projection.</summary>
    /// <param name="db">The database.</param>
    /// <param name="ingest">Supplies the offline threshold.</param>
    public CabinetProjection(SupportDbContext db, IOptions<AgentIngestOptions> ingest)
    {
        _db = db;
        _ingest = ingest.Value;
    }

    /// <inheritdoc />
    public IQueryable<Cabinet> FilterByHealth(IQueryable<Cabinet> cabinets, CabinetHealthStatus health, DateTimeOffset nowUtc)
    {
        var offlineBefore = nowUtc.AddMinutes(-_ingest.OfflineAfterMinutes);
        double criticalDrift = HealthEvaluator.CriticalClockDrift.TotalSeconds;
        double warningDrift = HealthEvaluator.WarningClockDrift.TotalSeconds;
        // Keep the priority order identical to HealthEvaluator: unavailable,
        // offline, critical, warning, incomplete, healthy. SMART is optional.
        // All operations translate to SQL.
        return cabinets.Where(c =>
            (!c.IsActive || c.LastCheckInUtc == null ? CabinetHealthStatus.Unknown :
             c.LastCheckInUtc < offlineBefore ? CabinetHealthStatus.Offline :
             _db.Heartbeats.Where(h => h.CabinetId == c.Id)
                .OrderByDescending(h => h.CollectedAtUtc).ThenByDescending(h => h.Id)
                .Select(h => (CabinetHealthStatus?)(
                    h.WorstDiskHealth == DiskHealthStatus.Failing ||
                    h.MinFreeDiskPercent <= HealthEvaluator.CriticalFreeDiskPercent ||
                    h.RamUsedPercent >= HealthEvaluator.CriticalRamPercent ||
                    h.ClockDriftSeconds >= criticalDrift || h.ClockDriftSeconds <= -criticalDrift
                        ? CabinetHealthStatus.Critical :
                    h.WorstDiskHealth == DiskHealthStatus.Watch ||
                    h.MinFreeDiskPercent <= HealthEvaluator.WarningFreeDiskPercent ||
                    h.RamUsedPercent >= HealthEvaluator.WarningRamPercent ||
                    h.CpuPercent >= HealthEvaluator.WarningCpuPercent ||
                    h.PendingUpdateCount >= HealthEvaluator.WarningPendingUpdates ||
                    h.ClockDriftSeconds >= warningDrift || h.ClockDriftSeconds <= -warningDrift
                        ? CabinetHealthStatus.Warning :
                    h.CpuPercent == null || h.RamUsedPercent == null || h.MinFreeDiskPercent == null ||
                    h.PendingUpdateCount == null || h.ClockDriftSeconds == null
                        ? CabinetHealthStatus.Unknown : CabinetHealthStatus.Healthy))
                .FirstOrDefault() ?? CabinetHealthStatus.Unknown) == health);
    }

    /// <inheritdoc />
    public async Task<List<CabinetSummary>> ProjectAsync(
        IQueryable<Cabinet> cabinets, DateTimeOffset nowUtc, CancellationToken ct)
    {
        // Collection order uses the unique (CabinetId, CollectedAtUtc) index.
        // Receipt order would promote a buffered replay above a newer sample.
        var rows = await cabinets
            .Select(c => new
            {
                Cabinet = c,
                SiteName = c.Site!.Name,
                ClientName = c.Site!.Client!.Name,
                Latest = _db.Heartbeats
                    .Where(h => h.CabinetId == c.Id)
                    .OrderByDescending(h => h.CollectedAtUtc).ThenByDescending(h => h.Id)
                    .Select(h => new
                    {
                        h.CollectedAtUtc,
                        h.ReceivedUtc,
                        h.CpuPercent,
                        h.RamUsedPercent,
                        h.MinFreeDiskPercent,
                        h.PendingUpdateCount,
                        h.RebootPending,
                        h.WorstDiskHealth,
                        h.AnyUserLoggedOn,
                        h.ClockDriftSeconds,
                    })
                    .FirstOrDefault(),
            })
            .ToListAsync(ct);

        return rows.Select(r =>
        {
            TimeSpan? drift = r.Latest?.ClockDriftSeconds is { } seconds
                ? TimeSpan.FromSeconds(seconds)
                : null;

            DiskHealthStatus diskHealth = r.Latest?.WorstDiskHealth ?? DiskHealthStatus.Unknown;

            return new CabinetSummary
            {
                Id = r.Cabinet.Id,
                MachineId = r.Cabinet.MachineId,
                Hostname = r.Cabinet.Hostname,
                FriendlyName = r.Cabinet.FriendlyName,
                ClientName = r.ClientName,
                SiteName = r.SiteName,
                SiteId = r.Cabinet.SiteId,
                DepartmentName = r.Cabinet.DepartmentName,
                Role = r.Cabinet.Role,
                Model = r.Cabinet.Model,
                SerialNumber = r.Cabinet.SerialNumber,
                IsActive = r.Cabinet.IsActive,
                LastCheckInUtc = r.Cabinet.LastCheckInUtc,
                LatestHeartbeatCollectedAtUtc = r.Latest?.CollectedAtUtc,
                LatestHeartbeatReceivedAtUtc = r.Latest?.ReceivedUtc,
                AgentVersion = r.Cabinet.AgentVersion,
                TimeZoneId = r.Cabinet.TimeZoneId,
                CpuPercent = r.Latest?.CpuPercent,
                RamUsedPercent = r.Latest?.RamUsedPercent,
                MinFreeDiskPercent = r.Latest?.MinFreeDiskPercent,
                PendingUpdateCount = r.Latest?.PendingUpdateCount,
                RebootPending = r.Latest?.RebootPending,
                WorstDiskHealth = diskHealth,
                AnyUserLoggedOn = r.Latest?.AnyUserLoggedOn,
                ClockDrift = drift,
                Health = HealthEvaluator.Evaluate(
                    r.Cabinet.IsActive,
                    r.Cabinet.LastCheckInUtc,
                    nowUtc,
                    _ingest.OfflineAfterMinutes,
                    r.Latest?.CpuPercent,
                    r.Latest?.RamUsedPercent,
                    r.Latest?.MinFreeDiskPercent,
                    r.Latest?.PendingUpdateCount,
                    diskHealth,
                    drift),
            };
        }).ToList();
    }
}
