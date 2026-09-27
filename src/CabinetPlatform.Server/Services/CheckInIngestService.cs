using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Services;

/// <summary>What one check-in did.</summary>
/// <param name="WasDuplicate">The sample had already been stored.</param>
/// <param name="InventoryUnchanged">The inventory matched the version in force, so nothing was written.</param>
/// <param name="ReceivedUtc">When the server took the sample.</param>
public sealed record CheckInIngestOutcome(
    bool WasDuplicate,
    bool InventoryUnchanged,
    DateTimeOffset ReceivedUtc);

/// <summary>Stores one agent observation according to its tier.</summary>
public interface ICheckInIngestService
{
    /// <summary>Ingests one payload.</summary>
    /// <param name="cabinet">The cabinet it came from, already resolved and checked.</param>
    /// <param name="tier">Which tier the payload arrived on.</param>
    /// <param name="payload">The payload.</param>
    /// <param name="ct">Cancels the ingest.</param>
    Task<OperationResult<CheckInIngestOutcome>> IngestAsync(
        Cabinet cabinet, CheckInTier tier, CheckInPayload payload, CancellationToken ct);
}

/// <summary>
/// Turns one agent observation into the rows its tier calls for, in a single
/// transaction, with an Observed audit record.
/// </summary>
/// <remarks>
/// <para>
/// The tiers exist because of volume. Seven thousand cabinets at a five-minute
/// cadence is roughly two million samples a day; storing a full payload for
/// each reaches terabytes within weeks, and almost none of it would ever be
/// read. So a heartbeat writes typed columns and no document; inventory writes
/// only when its content hash differs from the version in force; SMART writes
/// every time, because a gap in a failure-prediction series is a gap in the
/// prediction.
/// </para>
/// <para>
/// The tier is taken from the endpoint the request arrived on, never from the
/// payload. An agent cannot ask for its heavy sections to be stored by
/// claiming a tier, and a heartbeat that arrives carrying inventory has that
/// inventory ignored rather than written.
/// </para>
/// <para>
/// Cabinet LastCheckInUtc is transport contact. Heartbeat CollectedAtUtc,
/// LastFullCheckInUtc and inventory observation times are sample times. Only a
/// strictly newer sample can advance current facts; older unique samples retain
/// heartbeat and SMART history, not a replacement inventory. Timestamp identity
/// is first-write-wins across tiers, not a device sequence protocol: clock rollback,
/// equal-time distinct samples and replay after heartbeat retention remain limits.
/// </para>
/// </remarks>
public sealed class CheckInIngestService : ICheckInIngestService
{
    // The payload is stored verbatim in the shared wire convention, so it can
    // still be deserialised by any component years from now.
    private static readonly JsonSerializerOptions PayloadJsonOptions = ContractJson.CreateOptions();

    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly AgentIngestOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<CheckInIngestService> _logger;

    /// <summary>Creates the service.</summary>
    /// <param name="db">The database.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="options">Ingest configuration.</param>
    /// <param name="timeProvider">Clock.</param>
    /// <param name="logger">Diagnostic log.</param>
    public CheckInIngestService(
        SupportDbContext db,
        IAuditService audit,
        IOptions<AgentIngestOptions> options,
        TimeProvider timeProvider,
        ILogger<CheckInIngestService> logger)
    {
        _db = db;
        _audit = audit;
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task<OperationResult<CheckInIngestOutcome>> IngestAsync(
        Cabinet cabinet, CheckInTier tier, CheckInPayload payload, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();
        DateTimeOffset collectedUtc = payload.CollectedAtUtc.ToUniversalTime();

        if (collectedUtc > nowUtc.AddMinutes(_options.MaxClockSkewMinutes))
        {
            // A sample from the future is a broken clock or a replay attempt.
            // Either way it must not land in a trend a technician will read.
            return OperationResult<CheckInIngestOutcome>.Invalid(
                "CollectedAtUtc is implausibly far in the future.");
        }

        // Do not clamp a future timestamp to receipt time: that would make an
        // untrusted measurement current and poison ordering after clock repair.
        // Even within the diagnostic skew bound, wait for a corrected/retried
        // sample. Missing timestamps are not a usable measurement identity.
        if (collectedUtc == default || collectedUtc > nowUtc)
        {
            return OperationResult<CheckInIngestOutcome>.Invalid(
                "CollectedAtUtc must be present and not later than server time.");
        }

        // Serialize this cabinet's measurement decision and all its side effects
        // in the database, not a process-local lock. The controller's tracked
        // cabinet may predate a competing commit, so reload after taking the
        // write lock. PostgreSQL locks this row; SQLite serializes writers.
        await using var transaction = await _db.Database.BeginTransactionAsync(ct);
        await _db.Cabinets.Where(c => c.Id == cabinet.Id)
            .ExecuteUpdateAsync(setters => setters.SetProperty(c => c.LastCheckInUtc, c => c.LastCheckInUtc), ct);
        await _db.Entry(cabinet).ReloadAsync(ct);
        if (!cabinet.IsActive)
            return OperationResult<CheckInIngestOutcome>.Forbidden("Cabinet is no longer active.");
        nowUtc = _timeProvider.GetUtcNow();

        bool duplicate = await _db.Heartbeats
            .AsNoTracking()
            .AnyAsync(h => h.CabinetId == cabinet.Id && h.CollectedAtUtc == collectedUtc, ct);

        // The existing protocol identifies a sample by cabinet and collection
        // time, across tiers. Equal timestamps are first-write-wins, including
        // conflicting content: a retry cannot rewrite any sample side effects.
        if (duplicate)
        {
            cabinet.LastCheckInUtc = nowUtc;
            await _db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return OperationResult<CheckInIngestOutcome>.Ok(
                new CheckInIngestOutcome(true, true, nowUtc));
        }

        // Contact and measurement recency are separate. An older buffered sample
        // remains history, but cannot replace current facts or inventory.
        bool advancesCurrent = !await _db.Heartbeats.AsNoTracking()
            .AnyAsync(h => h.CabinetId == cabinet.Id && h.CollectedAtUtc >= collectedUtc, ct);
        cabinet.LastCheckInUtc = nowUtc;

        // Drift is the cabinet's own clock against the instant it says it
        // sampled at. Comparing against the server's receive time instead would
        // fold network latency into the measurement and call it drift.
        TimeSpan? clockDrift = payload.System?.SystemTimeUtc is { } reported
            ? reported - collectedUtc
            : null;

        var heartbeat = new Heartbeat
        {
            CabinetId = cabinet.Id,
            ReceivedUtc = nowUtc,
            CollectedAtUtc = collectedUtc,
            AgentVersion = payload.AgentVersion,
            UptimeSeconds = payload.System?.Uptime?.TotalSeconds,
            CpuPercent = payload.Performance?.CpuTotalPercent,
            RamUsedPercent = payload.Performance?.RamUsedPercent,
            MinFreeDiskPercent = MinFreeDiskPercent(payload),
            WorstDiskHealth = WorstDiskHealth(payload),
            AnyUserLoggedOn = payload.System?.AnyUserLoggedOn,
            PendingUpdateCount = payload.WindowsUpdate?.PendingUpdateCount,
            RebootPending = payload.WindowsUpdate?.RebootPending,
            ClockDriftSeconds = clockDrift?.TotalSeconds,
            SectionErrorsJson = JsonSerializer.Serialize(payload.SectionErrors, PayloadJsonOptions),
            IsAggregated = false,
            SampleCount = 1,
        };

        _db.Heartbeats.Add(heartbeat);

        bool inventoryUnchanged = true;

        if (tier == CheckInTier.Full)
        {
            if (advancesCurrent)
            {
                inventoryUnchanged = await StoreInventoryAsync(cabinet, payload, collectedUtc, ct);
                cabinet.LastFullCheckInUtc = collectedUtc;
            }

            // Unique older samples still belong in the historical SMART series;
            // duplicates have already returned without any sample side effects.
            StoreSmartReadings(cabinet, payload, collectedUtc);
        }

        if (advancesCurrent)
        {
            UpdateCabinetFacts(cabinet, payload);
        }

        // What the machine actually did with an install this platform asked
        // for, as opposed to the fact that one was scheduled. Recorded whatever
        // the tier: an outcome arrives when the install finishes, which is
        // rarely the moment a full check-in is due.
        await RecordUpdateOutcomesAsync(cabinet, payload, ct);

        if (clockDrift is { } drift && drift.Duration() >= HealthEvaluator.WarningClockDrift)
        {
            // Worth its own record: drift breaks site synchronisation and audit
            // correlation, and neither failure announces itself at the time.
            _audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.CabinetClockDrift,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Success,
                ActorType = ActorType.Agent,
                ActorId = cabinet.MachineId,
                CabinetId = cabinet.Id,
                CabinetHostname = cabinet.Hostname,
                Reason = $"Cabinet clock differs from its own sample time by {drift:g}.",
                Details = new { DriftSeconds = drift.TotalSeconds, cabinet.TimeZoneId },
            });
        }

        // A check-in changed nothing on the cabinet; the server merely saw it.
        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.AgentCheckIn,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.Agent,
            ActorId = cabinet.MachineId,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            Details = new
            {
                Tier = tier.ToString(),
                heartbeat.CollectedAtUtc,
                heartbeat.CpuPercent,
                heartbeat.RamUsedPercent,
                heartbeat.MinFreeDiskPercent,
                heartbeat.PendingUpdateCount,
                WorstDiskHealth = heartbeat.WorstDiskHealth.ToString(),
                heartbeat.AnyUserLoggedOn,
                SmartReadingCount = CountSmartReadings(payload),
                FailedSections = payload.SectionErrors.Keys.ToArray(),
                InventoryUnchanged = inventoryUnchanged,
            },
        });

        await _db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);

        return OperationResult<CheckInIngestOutcome>.Ok(
            new CheckInIngestOutcome(false, inventoryUnchanged, nowUtc));
    }

    /// <summary>
    /// Stores the inventory sections, but only when they differ from the
    /// version already in force.
    /// </summary>
    /// <remarks>
    /// The stored document carries the sections whole; the hash is taken over a
    /// deliberately narrower projection. Otherwise a service restarting under a
    /// new process id, or a disk losing a gigabyte of free space, would present
    /// as an inventory change every six hours and the tier would store as much
    /// as it was built to avoid.
    /// </remarks>
    /// <returns>True when nothing was written because nothing changed.</returns>
    private async Task<bool> StoreInventoryAsync(
        Cabinet cabinet, CheckInPayload payload, DateTimeOffset observedUtc, CancellationToken ct)
    {
        var stored = new InventorySnapshot
        {
            System = payload.System,
            Services = payload.Services,
            Network = payload.Network,
            WindowsUpdate = payload.WindowsUpdate,
            Disks = payload.Disks,
            Performance = payload.Performance is null
                ? null
                : new PerformanceInfo
                {
                    RamTotalBytes = payload.Performance.RamTotalBytes,
                    PageFileTotalBytes = payload.Performance.PageFileTotalBytes,
                    StartupPrograms = payload.Performance.StartupPrograms,
                },
        };

        string json = JsonSerializer.Serialize(stored, PayloadJsonOptions);
        string hash = Sha256Hex(JsonSerializer.Serialize(StableProjection(payload), PayloadJsonOptions));

        InventoryVersion? current = cabinet.CurrentInventoryVersionId is { } id
            ? await _db.InventoryVersions.FirstOrDefaultAsync(v => v.Id == id, ct)
            : null;

        if (current is not null && current.ContentHash == hash)
        {
            // The whole point of the tier: an unchanged inventory writes one
            // timestamp, not a second copy of itself.
            current.LastObservedUtc = observedUtc;
            return true;
        }

        var version = new InventoryVersion
        {
            CabinetId = cabinet.Id,
            ContentHash = hash,
            FirstObservedUtc = observedUtc,
            LastObservedUtc = observedUtc,
            PayloadJson = json,
            SectionErrorsJson = JsonSerializer.Serialize(payload.SectionErrors, PayloadJsonOptions),
        };

        _db.InventoryVersions.Add(version);
        cabinet.CurrentInventoryVersionId = version.Id;
        return false;
    }

    /// <summary>
    /// The parts of a payload that constitute the cabinet's configuration, as
    /// opposed to its current condition.
    /// </summary>
    /// <remarks>
    /// A section that failed to collect is null here and hashes differently
    /// from an empty one, which is correct: "we could not read the services"
    /// and "this machine runs no services" are different inventories, and only
    /// one of them is plausible.
    /// </remarks>
    private static object StableProjection(CheckInPayload payload) => new
    {
        System = payload.System is null
            ? null
            : new
            {
                payload.System.Hostname,
                payload.System.OsVersion,
                payload.System.OsBuild,
                payload.System.InstallDateUtc,
                payload.System.TimeZoneId,
                payload.System.DomainOrWorkgroup,
                payload.System.IsDomainJoined,
                InstalledSoftware = payload.System.InstalledSoftware?
                    .OrderBy(s => s.Name, StringComparer.Ordinal)
                    .Select(s => new { s.Name, s.Version, s.Publisher })
                    .ToArray(),
            },

        // Process id is excluded: a service restarting is not a different
        // inventory, and including it would create a version per restart.
        Services = payload.Services?
            .OrderBy(s => s.Name, StringComparer.Ordinal)
            .Select(s => new { s.Name, s.DisplayName, s.State, s.StartType, s.RunAsAccount })
            .ToArray(),

        // Reachability and latency are condition, not configuration.
        Network = payload.Network is null
            ? null
            : new
            {
                payload.Network.ProxyConfigured,
                payload.Network.ProxyAddress,
                payload.Network.FirewallDomainEnabled,
                payload.Network.FirewallPrivateEnabled,
                payload.Network.FirewallPublicEnabled,
                Adapters = payload.Network.Adapters?
                    .OrderBy(a => a.Name, StringComparer.Ordinal)
                    .Select(a => new
                    {
                        a.Name,
                        a.Description,
                        a.MacAddress,
                        a.Status,
                        a.LinkSpeedBps,
                        a.IpAddresses,
                        a.SubnetMasks,
                        a.Gateways,
                        a.DnsServers,
                        a.DhcpEnabled,
                    })
                    .ToArray(),
            },

        // Update history grows on every install, so it is stored but not
        // hashed; the policy and the pending set are what a change means here.
        WindowsUpdate = payload.WindowsUpdate is null
            ? null
            : new
            {
                payload.WindowsUpdate.PendingUpdateCount,
                payload.WindowsUpdate.RebootPending,
                payload.WindowsUpdate.ActiveHoursStart,
                payload.WindowsUpdate.ActiveHoursEnd,
                payload.WindowsUpdate.IsManagedByPolicy,
                payload.WindowsUpdate.DeferralDays,
                PendingUpdates = payload.WindowsUpdate.PendingUpdates?
                    .OrderBy(u => u.UpdateId, StringComparer.Ordinal)
                    .Select(u => new { u.UpdateId, u.Title, u.Classification, u.IsSecurity })
                    .ToArray(),
            },

        // Free space is condition. Capacity, file system and encryption state
        // are configuration, and a volume losing its BitLocker protection is
        // exactly the change this history exists to make visible.
        Disks = payload.Disks?
            .OrderBy(d => d.DriveLetter, StringComparer.Ordinal)
            .Select(d => new { d.DriveLetter, d.Label, d.FileSystem, d.TotalBytes, d.BitLockerStatus })
            .ToArray(),

        // Installed memory and what the machine launches at logon are
        // configuration; utilisation and the process list are condition and are
        // excluded, or every sample would be a new inventory.
        Performance = payload.Performance is null
            ? null
            : new
            {
                payload.Performance.RamTotalBytes,
                payload.Performance.PageFileTotalBytes,
                StartupPrograms = payload.Performance.StartupPrograms?
                    .OrderBy(p => p.Name, StringComparer.Ordinal)
                    .Select(p => new { p.Name, p.Command, p.Location })
                    .ToArray(),
            },
    };

    /// <summary>
    /// Writes one SMART row per drive that reported anything.
    /// </summary>
    /// <remarks>
    /// A drive with no serial is dropped rather than stored unattributable:
    /// without a stable identity there is nothing to trend the row against, and
    /// a row that cannot be trended is noise in the table this system exists
    /// for.
    /// </remarks>
    private void StoreSmartReadings(Cabinet cabinet, CheckInPayload payload, DateTimeOffset collectedUtc)
    {
        if (payload.Disks is null)
        {
            return;
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (DiskInfo disk in payload.Disks)
        {
            if (disk.Smart is not { } smart)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(smart.SerialNumber))
            {
                _logger.LogDebug(
                    "Dropped a SMART reading with no drive serial from cabinet {CabinetId}.", cabinet.Id);
                continue;
            }

            string serial = smart.SerialNumber.Trim();

            // Several volumes can sit on one physical drive, and each carries
            // the same SMART block. One row per drive, not one per letter.
            if (!seen.Add(serial))
            {
                continue;
            }

            _db.SmartReadings.Add(new SmartReading
            {
                CabinetId = cabinet.Id,
                DriveSerial = serial,
                DriveModel = smart.Model,
                TimestampUtc = collectedUtc,
                Health = disk.HealthStatus,
                Source = smart.Source,
                ReallocatedSectorCount = smart.ReallocatedSectorCount,
                PendingSectorCount = smart.PendingSectorCount,
                UncorrectableErrorCount = smart.UncorrectableErrorCount,
                PowerOnHours = smart.PowerOnHours,
                TemperatureCelsius = smart.TemperatureCelsius,
                OverallPredictFailure = smart.OverallPredictFailure,
                PredictFailureReason = smart.PredictFailureReason,
                Wear = smart.Wear,
                ReadErrorsTotal = smart.ReadErrorsTotal,
                ReadErrorsUncorrected = smart.ReadErrorsUncorrected,
                WriteErrorsTotal = smart.WriteErrorsTotal,
                WriteErrorsUncorrected = smart.WriteErrorsUncorrected,
                TemperatureMax = smart.TemperatureMax,
                StartStopCycleCount = smart.StartStopCycleCount,
                IsAggregated = false,
            });
        }
    }

    private static void UpdateCabinetFacts(Cabinet cabinet, CheckInPayload payload)
    {
        if (!string.IsNullOrWhiteSpace(payload.AgentVersion))
        {
            cabinet.AgentVersion = payload.AgentVersion.Trim();
        }

        if (!string.IsNullOrWhiteSpace(payload.System?.Hostname))
        {
            // The agent may legitimately report a renamed host. It still cannot
            // touch its site, its client or its role — those are the approving
            // Supervisor's to set.
            cabinet.Hostname = payload.System.Hostname.Trim();
        }

        if (!string.IsNullOrWhiteSpace(payload.System?.TimeZoneId))
        {
            cabinet.TimeZoneId = payload.System.TimeZoneId.Trim();
        }

        string? address = PrimaryAddress(payload.Network);

        if (address is not null)
        {
            // This is what a cabinet-to-cabinet probe is later resolved
            // against, which is why the console never supplies an address.
            cabinet.LastKnownIpAddress = address;
        }

        // Two fleet-wide counts, extracted here so the dashboard reads columns
        // instead of opening seven thousand inventory documents. Both are left
        // alone when the section they come from is absent: a heartbeat carries
        // neither, and overwriting a known count with null every five minutes
        // would make the fleet view flicker between the truth and nothing.
        if (payload.WindowsUpdate?.PendingUpdates is { } pending)
        {
            cabinet.PendingSecurityUpdateCount = pending.Count(u =>
                u.IsSecurity == true || u.Classification == UpdateClassification.SecurityUpdate);
        }

        if (payload.Services is { } services)
        {
            // Automatic and automatic-delayed both count. A delayed-start
            // service that is stopped long after boot is as broken as an
            // ordinary one, and the distinction is about start order rather
            // than about whether it should be running.
            cabinet.AutoStartServicesStoppedCount = services.Count(svc =>
                svc.StartType is ServiceStartType.Automatic or ServiceStartType.AutomaticDelayed &&
                svc.State == ServiceState.Stopped);
        }
    }

    /// <summary>
    /// Turns a reported install outcome into a Caused audit entry against the
    /// action that asked for it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Caused rather than Observed, and that is the whole point of this method.
    /// The platform asked for the install; Windows performed it. A fleet that
    /// records only "we scheduled it" believes it is patched the moment the
    /// request is dispatched, when the machine may still reboot into a
    /// rollback, run out of disk, or find the package superseded.
    /// </para>
    /// <para>
    /// The outcome is attached to the action request as its result, so the
    /// console shows what happened where a rep already looks, rather than in a
    /// second place they would have to know about.
    /// </para>
    /// </remarks>
    private async Task RecordUpdateOutcomesAsync(
        Cabinet cabinet, CheckInPayload payload, CancellationToken ct)
    {
        if (payload.UpdateInstallOutcomes is not { Count: > 0 } outcomes)
        {
            return;
        }

        List<Guid> ids = outcomes.Select(o => o.ActionRequestId).Distinct().ToList();

        List<ActionRequest> requests = await _db.ActionRequests
            .Where(a => ids.Contains(a.Id) && a.CabinetId == cabinet.Id)
            .ToListAsync(ct);

        var byId = requests.ToDictionary(a => a.Id);

        foreach (UpdateInstallOutcome outcome in outcomes)
        {
            // An outcome naming an action that belongs to another cabinet, or
            // none at all, is dropped rather than stored against whatever it
            // happens to match. An agent cannot report on somebody else's work.
            if (!byId.TryGetValue(outcome.ActionRequestId, out ActionRequest? request))
            {
                _logger.LogWarning(
                    "Cabinet {CabinetId} reported an update outcome for action {ActionRequestId}, " +
                    "which is not an action on that cabinet. It was discarded.",
                    cabinet.Id,
                    outcome.ActionRequestId);

                continue;
            }

            var failed = outcome.Results
                .Where(r => r.ResultCode is not (UpdateResultCode.Succeeded
                    or UpdateResultCode.SucceededWithErrors))
                .ToList();

            _audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.UpdateInstallOutcome,
                Action = request.Action,
                EventKind = AuditEventKind.Caused,
                Result = failed.Count == 0 ? AuditResult.Success : AuditResult.Failure,
                ActorType = ActorType.Agent,
                ActorId = cabinet.MachineId,
                CabinetId = cabinet.Id,
                CabinetHostname = cabinet.Hostname,
                Reason = failed.Count == 0
                    ? $"{outcome.Results.Count} update(s) installed."
                    : $"{failed.Count} of {outcome.Results.Count} update(s) did not install.",
                Details = new
                {
                    ActionRequestId = request.Id,
                    outcome.CompletedUtc,
                    outcome.RebootRequired,
                    Results = outcome.Results.Select(r => new
                    {
                        r.UpdateId,
                        r.Title,
                        ResultCode = r.ResultCode.ToString(),
                        r.ErrorCode,
                    }),
                },
            });

            // The outcome lands on the request that caused it, so a rep reading
            // the action sees what it did rather than only that it was sent.
            request.CollectedDataJson = JsonSerializer.Serialize(outcome, PayloadJsonOptions);
        }
    }

    /// <summary>
    /// Picks the address another cabinet at the same site would reach this one
    /// on: the first address of the first adapter that is up and has a gateway.
    /// </summary>
    private static string? PrimaryAddress(NetworkInfo? network)
    {
        if (network?.Adapters is null)
        {
            return null;
        }

        foreach (NetworkAdapterInfo adapter in network.Adapters)
        {
            if (adapter.Status != NetworkAdapterStatus.Up ||
                adapter.Gateways is not { Count: > 0 } ||
                adapter.IpAddresses is not { Count: > 0 })
            {
                continue;
            }

            foreach (string candidate in adapter.IpAddresses)
            {
                if (System.Net.IPAddress.TryParse(candidate, out System.Net.IPAddress? parsed) &&
                    parsed.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                {
                    return parsed.ToString();
                }
            }
        }

        return null;
    }

    /// <summary>
    /// The tightest volume on the machine.
    /// </summary>
    /// <remarks>
    /// A cabinet with a comfortable C: and a full data partition is a cabinet
    /// about to stop recording dispenses, so the minimum is what the fleet view
    /// needs, not the average. Null when no volume reported a figure — which is
    /// not the same as a full disk, and is not the same as an empty one.
    /// </remarks>
    private static double? MinFreeDiskPercent(CheckInPayload payload)
    {
        if (payload.Disks is null)
        {
            return null;
        }

        double? lowest = null;

        foreach (DiskInfo disk in payload.Disks)
        {
            if (disk.FreePercent is { } percent && (lowest is null || percent < lowest))
            {
                lowest = percent;
            }
        }

        return lowest;
    }

    private static DiskHealthStatus WorstDiskHealth(CheckInPayload payload)
    {
        if (payload.Disks is null)
        {
            return DiskHealthStatus.Unknown;
        }

        DiskHealthStatus worst = payload.Disks.FirstOrDefault()?.HealthStatus ?? DiskHealthStatus.Unknown;

        foreach (DiskInfo disk in payload.Disks)
        {
            // Ordered by severity, and Unknown is not the mildest: a drive
            // whose health could not be read must not be outranked by a healthy
            // one and disappear from the roll-up.
            if (Severity(disk.HealthStatus) > Severity(worst))
            {
                worst = disk.HealthStatus;
            }
        }

        return worst;
    }

    private static int Severity(DiskHealthStatus status) => status switch
    {
        DiskHealthStatus.Healthy => 0,
        DiskHealthStatus.Unknown => 1,
        DiskHealthStatus.Watch => 2,
        DiskHealthStatus.Failing => 3,
        _ => 1,
    };

    private static int CountSmartReadings(CheckInPayload payload) =>
        payload.Disks?.Count(d => d.Smart is not null) ?? 0;

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    /// <summary>
    /// The inventory half of a payload, hashed and stored as one document.
    /// </summary>
    /// <remarks>
    /// A separate shape rather than the whole payload, so that the volatile
    /// parts — CPU percent, uptime, the collection timestamp — cannot make an
    /// otherwise unchanged inventory look different every six hours.
    /// </remarks>
    private sealed record InventorySnapshot
    {
        public SystemInfo? System { get; init; }

        public IReadOnlyList<ServiceInfo>? Services { get; init; }

        public NetworkInfo? Network { get; init; }

        public WindowsUpdateInfo? WindowsUpdate { get; init; }

        public IReadOnlyList<DiskInfo>? Disks { get; init; }

        /// <summary>
        /// The configuration half of the performance section: installed memory
        /// and what the machine launches at logon.
        /// </summary>
        /// <remarks>
        /// The counters are deliberately not stored here. CPU and memory
        /// utilisation are a sample taken at one instant, they ride the
        /// heartbeat, and putting them in a change history would make every
        /// six-hourly check-in look like a change — which is the exact cost
        /// this tier exists to avoid.
        /// </remarks>
        public PerformanceInfo? Performance { get; init; }
    }
}
