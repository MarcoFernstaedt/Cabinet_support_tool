using System.Text.Json;
using CabinetPlatform.Contracts.Agent;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
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

[Route("api/cabinets")]
public sealed class CabinetsController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly AgentIngestOptions _ingestOptions;
    private readonly QueryLimitsOptions _queryLimits;
    private readonly TimeProvider _timeProvider;

    public CabinetsController(
        SupportDbContext db,
        IAuditService audit,
        IOptions<AgentIngestOptions> ingestOptions,
        IOptions<QueryLimitsOptions> queryLimits,
        TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _ingestOptions = ingestOptions.Value;
        _queryLimits = queryLimits.Value;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// The fleet grid. Projects straight to the extracted columns and joins to
    /// the newest check-in per cabinet — the stored payload is never touched,
    /// because deserialising ten thousand of them to draw a list would fall over.
    /// </summary>
    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(PagedResult<CabinetSummary>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<CabinetSummary>>> List(
        [FromQuery] CabinetQuery query, CancellationToken ct)
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

        if (query.IsActive is { } isActive)
        {
            cabinets = cabinets.Where(c => c.IsActive == isActive);
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            string term = query.Search.Trim();
            cabinets = cabinets.Where(c =>
                EF.Functions.Like(c.Hostname, $"%{term}%") ||
                EF.Functions.Like(c.MachineId, $"%{term}%") ||
                EF.Functions.Like(c.ClientName, $"%{term}%") ||
                EF.Functions.Like(c.SiteName, $"%{term}%"));
        }

        int total = await cabinets.CountAsync(ct);

        // The correlated sub-query rides the (CabinetId, ReceivedUtc desc)
        // index, so this stays one indexed seek per row rather than a scan.
        var rows = await cabinets
            .OrderBy(c => c.ClientName).ThenBy(c => c.SiteName).ThenBy(c => c.Hostname)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .Select(c => new
            {
                Cabinet = c,
                Latest = _db.CheckIns
                    .Where(ci => ci.CabinetId == c.Id)
                    .OrderByDescending(ci => ci.ReceivedUtc)
                    .Select(ci => new
                    {
                        ci.CpuPercent,
                        ci.RamUsedPercent,
                        ci.MinFreeDiskPercent,
                        ci.PendingUpdateCount,
                        ci.WorstDiskHealth,
                        ci.AnyUserLoggedOn
                    })
                    .FirstOrDefault()
            })
            .ToListAsync(ct);

        List<CabinetSummary> items = rows
            .Select(r => new CabinetSummary
            {
                Id = r.Cabinet.Id,
                MachineId = r.Cabinet.MachineId,
                Hostname = r.Cabinet.Hostname,
                ClientName = r.Cabinet.ClientName,
                SiteName = r.Cabinet.SiteName,
                DepartmentName = r.Cabinet.DepartmentName,
                Model = r.Cabinet.Model,
                SerialNumber = r.Cabinet.SerialNumber,
                IsActive = r.Cabinet.IsActive,
                LastCheckInUtc = r.Cabinet.LastCheckInUtc,
                AgentVersion = r.Cabinet.AgentVersion,
                CpuPercent = r.Latest?.CpuPercent,
                RamUsedPercent = r.Latest?.RamUsedPercent,
                MinFreeDiskPercent = r.Latest?.MinFreeDiskPercent,
                PendingUpdateCount = r.Latest?.PendingUpdateCount,
                WorstDiskHealth = r.Latest?.WorstDiskHealth,
                AnyUserLoggedOn = r.Latest?.AnyUserLoggedOn,
                Health = HealthEvaluator.Evaluate(
                    r.Cabinet.IsActive,
                    r.Cabinet.LastCheckInUtc,
                    nowUtc,
                    _ingestOptions.OfflineAfterMinutes,
                    r.Latest?.CpuPercent,
                    r.Latest?.RamUsedPercent,
                    r.Latest?.MinFreeDiskPercent,
                    r.Latest?.PendingUpdateCount,
                    r.Latest?.WorstDiskHealth)
            })
            .Where(s => query.Health is null || s.Health == query.Health)
            .ToList();

        await _audit.WriteAsync(Observed(AuditActions.ListCabinets, new
        {
            query.ClientName,
            query.SiteName,
            query.Page,
            query.PageSize,
            ResultCount = items.Count
        }), ct);

        return Ok(PagedResult<CabinetSummary>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>The newest observation for one cabinet, payload included.</summary>
    [HttpGet("{id:guid}/latest")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(CabinetLatestDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CabinetLatestDto>> Latest(Guid id, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        Domain.Cabinet? cabinet = await _db.Cabinets.AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == id, ct);

        if (cabinet is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.ViewCabinetLatest, "Cabinet not found.", id, null, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        Domain.CheckIn? latest = await _db.CheckIns.AsNoTracking()
            .Where(c => c.CabinetId == id)
            .OrderByDescending(c => c.ReceivedUtc)
            .FirstOrDefaultAsync(ct);

        // One row per drive: the newest reading for each serial this cabinet
        // has ever reported, rather than the newest handful overall.
        //
        // Expressed as a correlated max rather than GroupBy().Select(g =>
        // g.First()), which no relational provider can translate and which
        // therefore threw on every cabinet that had ever reported a drive.
        List<Domain.SmartReading> newestPerDrive = await _db.SmartReadings.AsNoTracking()
            .Where(s => s.CabinetId == id)
            .Where(s => s.TimestampUtc == _db.SmartReadings
                .Where(other => other.CabinetId == id && other.DriveSerial == s.DriveSerial)
                .Max(other => other.TimestampUtc))
            .ToListAsync(ct);

        // A drive can hold two rows at the identical instant once retention has
        // rolled a day up, so the tie is broken in memory — over a handful of
        // drives, not a table scan. The as-sampled reading wins: it is the
        // actual observation, and the roll-up is a summary of it.
        List<SmartReadingDto> smart = newestPerDrive
            .GroupBy(s => s.DriveSerial)
            .Select(g => ToDto(g
                .OrderBy(s => s.IsAggregated)
                .ThenBy(s => s.Id)
                .First()))
            .ToList();

        var dto = new CabinetLatestDto
        {
            Cabinet = new CabinetSummary
            {
                Id = cabinet.Id,
                MachineId = cabinet.MachineId,
                Hostname = cabinet.Hostname,
                ClientName = cabinet.ClientName,
                SiteName = cabinet.SiteName,
                DepartmentName = cabinet.DepartmentName,
                Model = cabinet.Model,
                SerialNumber = cabinet.SerialNumber,
                IsActive = cabinet.IsActive,
                LastCheckInUtc = cabinet.LastCheckInUtc,
                AgentVersion = cabinet.AgentVersion,
                CpuPercent = latest?.CpuPercent,
                RamUsedPercent = latest?.RamUsedPercent,
                MinFreeDiskPercent = latest?.MinFreeDiskPercent,
                PendingUpdateCount = latest?.PendingUpdateCount,
                WorstDiskHealth = latest?.WorstDiskHealth,
                AnyUserLoggedOn = latest?.AnyUserLoggedOn,
                Health = HealthEvaluator.Evaluate(
                    cabinet.IsActive, cabinet.LastCheckInUtc, nowUtc,
                    _ingestOptions.OfflineAfterMinutes,
                    latest?.CpuPercent, latest?.RamUsedPercent, latest?.MinFreeDiskPercent,
                    latest?.PendingUpdateCount, latest?.WorstDiskHealth)
            },
            LatestCheckIn = latest is null ? null : new CheckInDetailDto
            {
                Id = latest.Id,
                ReceivedUtc = latest.ReceivedUtc,
                CollectedAtUtc = latest.CollectedAtUtc,
                CpuPercent = latest.CpuPercent,
                RamUsedPercent = latest.RamUsedPercent,
                MinFreeDiskPercent = latest.MinFreeDiskPercent,
                PendingUpdateCount = latest.PendingUpdateCount,
                WorstDiskHealth = latest.WorstDiskHealth,
                AnyUserLoggedOn = latest.AnyUserLoggedOn,
                Payload = DeserialisePayload(latest.PayloadJson)
            },
            LatestSmartReadings = smart
        };

        await _audit.WriteAsync(Observed(
            AuditActions.ViewCabinetLatest, new { CabinetId = id }, cabinet), ct);

        return Ok(dto);
    }

    /// <summary>
    /// Paged check-in history over a bounded window. Returns summaries only —
    /// the payload column is never read by a list view.
    /// </summary>
    [HttpGet("{id:guid}/history")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(PagedResult<CheckInSummaryDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PagedResult<CheckInSummaryDto>>> History(
        Guid id, [FromQuery] HistoryQuery query, CancellationToken ct)
    {
        OperationResult<(DateTime From, DateTime To)> range = ResolveRange(query);

        if (!range.Succeeded)
        {
            await _audit.WriteDenialAsync(
                AuditActions.ViewCabinetHistory, range.Reason!, id, null, ct);
            return Problem(range);
        }

        if (!await _db.Cabinets.AsNoTracking().AnyAsync(c => c.Id == id, ct))
        {
            await _audit.WriteDenialAsync(
                AuditActions.ViewCabinetHistory, "Cabinet not found.", id, null, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        (DateTime from, DateTime to) = range.Value;

        IQueryable<Domain.CheckIn> rows = _db.CheckIns.AsNoTracking()
            .Where(c => c.CabinetId == id && c.ReceivedUtc >= from && c.ReceivedUtc <= to);

        int total = await rows.CountAsync(ct);

        List<CheckInSummaryDto> items = await rows
            .OrderByDescending(c => c.ReceivedUtc)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .Select(c => new CheckInSummaryDto
            {
                Id = c.Id,
                ReceivedUtc = c.ReceivedUtc,
                CollectedAtUtc = c.CollectedAtUtc,
                CpuPercent = c.CpuPercent,
                RamUsedPercent = c.RamUsedPercent,
                MinFreeDiskPercent = c.MinFreeDiskPercent,
                PendingUpdateCount = c.PendingUpdateCount,
                WorstDiskHealth = c.WorstDiskHealth,
                AnyUserLoggedOn = c.AnyUserLoggedOn
            })
            .ToListAsync(ct);

        await _audit.WriteAsync(Observed(AuditActions.ViewCabinetHistory,
            new { CabinetId = id, From = from, To = to, ResultCount = items.Count }), ct);

        return Ok(PagedResult<CheckInSummaryDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>Paged SMART history for one cabinet, optionally one drive.</summary>
    [HttpGet("{id:guid}/smart-history")]
    [Authorize(Policy = AuthorizationPolicies.RequireTier1)]
    [ProducesResponseType(typeof(PagedResult<SmartReadingDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PagedResult<SmartReadingDto>>> SmartHistory(
        Guid id, [FromQuery] SmartHistoryQuery query, CancellationToken ct)
    {
        OperationResult<(DateTime From, DateTime To)> range = ResolveRange(query);

        if (!range.Succeeded)
        {
            await _audit.WriteDenialAsync(AuditActions.ViewSmartHistory, range.Reason!, id, null, ct);
            return Problem(range);
        }

        if (!await _db.Cabinets.AsNoTracking().AnyAsync(c => c.Id == id, ct))
        {
            await _audit.WriteDenialAsync(
                AuditActions.ViewSmartHistory, "Cabinet not found.", id, null, ct);
            return Problem("Cabinet not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        (DateTime from, DateTime to) = range.Value;

        IQueryable<Domain.SmartReading> rows = _db.SmartReadings.AsNoTracking()
            .Where(s => s.CabinetId == id && s.TimestampUtc >= from && s.TimestampUtc <= to);

        if (!string.IsNullOrWhiteSpace(query.DriveSerial))
        {
            string serial = query.DriveSerial.Trim();
            rows = rows.Where(s => s.DriveSerial == serial);
        }

        int total = await rows.CountAsync(ct);

        List<SmartReadingDto> items = await rows
            .OrderByDescending(s => s.TimestampUtc)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .Select(s => ToDto(s))
            .ToListAsync(ct);

        await _audit.WriteAsync(Observed(AuditActions.ViewSmartHistory, new
        {
            CabinetId = id,
            query.DriveSerial,
            From = from,
            To = to,
            ResultCount = items.Count
        }), ct);

        return Ok(PagedResult<SmartReadingDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// Resolves the requested window, refusing one wider than policy allows.
    /// Silently clamping would hand back a partial answer that looks complete.
    /// </summary>
    private OperationResult<(DateTime From, DateTime To)> ResolveRange(HistoryQuery query)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        DateTime to = query.ToUtc ?? nowUtc;
        DateTime from = query.FromUtc ?? to.AddDays(-_queryLimits.DefaultHistoryRangeDays);

        if (from >= to)
        {
            return OperationResult<(DateTime, DateTime)>.Invalid("FromUtc must be earlier than ToUtc.");
        }

        if ((to - from).TotalDays > _queryLimits.MaxHistoryRangeDays)
        {
            return OperationResult<(DateTime, DateTime)>.Invalid(
                $"The requested range exceeds the maximum of {_queryLimits.MaxHistoryRangeDays} days.");
        }

        return OperationResult<(DateTime, DateTime)>.Ok((from, to));
    }

    private AuditRecord Observed(string action, object? details, Domain.Cabinet? cabinet = null)
    {
        CurrentUser actor = CurrentUser;

        return new AuditRecord
        {
            Action = action,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = cabinet?.Id,
            CabinetHostname = cabinet?.Hostname,
            Details = details
        };
    }

    private static CheckInRequest? DeserialisePayload(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<CheckInRequest>(json, Contracts.Common.ContractJson.Default);
        }
        catch (JsonException)
        {
            // An unreadable payload must not take the whole response down: the
            // projected columns beside it are still perfectly good data.
            return null;
        }
    }

    private static SmartReadingDto ToDto(Domain.SmartReading s) => new()
    {
        Id = s.Id,
        DriveSerial = s.DriveSerial,
        DriveModel = s.DriveModel,
        TimestampUtc = s.TimestampUtc,
        PredictedHealth = s.PredictedHealth,
        IsAggregated = s.IsAggregated,
        ReallocatedSectorCount = s.ReallocatedSectorCount,
        ReportedUncorrectableErrors = s.ReportedUncorrectableErrors,
        CommandTimeoutCount = s.CommandTimeoutCount,
        CurrentPendingSectorCount = s.CurrentPendingSectorCount,
        OfflineUncorrectableCount = s.OfflineUncorrectableCount,
        UdmaCrcErrorCount = s.UdmaCrcErrorCount,
        SpinRetryCount = s.SpinRetryCount,
        SeekErrorRate = s.SeekErrorRate,
        ReadErrorRate = s.ReadErrorRate,
        WearLevelingCount = s.WearLevelingCount,
        PercentageUsed = s.PercentageUsed,
        AvailableSparePercent = s.AvailableSparePercent,
        AvailableSpareThresholdPercent = s.AvailableSpareThresholdPercent,
        MediaAndDataIntegrityErrors = s.MediaAndDataIntegrityErrors,
        UnsafeShutdownCount = s.UnsafeShutdownCount,
        PowerOnHours = s.PowerOnHours,
        PowerCycleCount = s.PowerCycleCount,
        TemperatureCelsius = s.TemperatureCelsius,
        TotalHostReadsGb = s.TotalHostReadsGb,
        TotalHostWritesGb = s.TotalHostWritesGb
    };
}
