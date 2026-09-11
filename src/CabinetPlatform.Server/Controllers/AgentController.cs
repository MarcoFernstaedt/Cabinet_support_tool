using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Controllers;

/// <summary>
/// The agent-facing surface.
/// </summary>
/// <remarks>
/// Every action here authenticates through <see cref="IAgentAuthenticator"/>
/// and then — separately — resolves the cabinet from the database and checks
/// that a Supervisor approved it. Presenting a valid agent key proves only that
/// the caller is some agent; it never proves the caller is a cabinet this fleet
/// has admitted.
/// </remarks>
[Route("api/agent")]
public sealed class AgentController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly ICheckInIngestService _ingest;
    private readonly AgentIngestOptions _options;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the controller.</summary>
    /// <param name="db">The database.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="ingest">Stores check-ins by tier.</param>
    /// <param name="options">Ingest configuration.</param>
    /// <param name="timeProvider">Clock.</param>
    public AgentController(
        SupportDbContext db,
        IAuditService audit,
        ICheckInIngestService ingest,
        IOptions<AgentIngestOptions> options,
        TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _ingest = ingest;
        _options = options.Value;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// Announces an agent. Creates or refreshes a pending registration and
    /// tells the agent to wait.
    /// </summary>
    /// <remarks>
    /// It never returns fleet information, and it never admits the machine —
    /// only a Supervisor does that. Once admitted, it returns the cabinet id
    /// the agent then reports under.
    /// </remarks>
    /// <param name="request">What the agent says about itself.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("register")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentRegister)]
    [ProducesResponseType(typeof(RegistrationResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<RegistrationResponse>> Register(
        [FromBody] RegistrationRequest request,
        CancellationToken ct)
    {
        string machineId = RequireMachineIdMatch(request.MachineId);
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        Cabinet? cabinet = await _db.Cabinets
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.MachineId == machineId, ct);

        if (cabinet is not null)
        {
            // Already admitted. Say so, and hand back the identity, without
            // disclosing which clinic, site or department it was filed under.
            await _audit.WriteAsync(new AuditRecord
            {
                Event = AuditEvent.AgentRegister,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Success,
                ActorType = ActorType.Agent,
                ActorId = machineId,
                CabinetId = cabinet.Id,
                CabinetHostname = cabinet.Hostname,
                Reason = "Agent re-registered an already-approved cabinet.",
            }, ct);

            return Ok(new RegistrationResponse
            {
                Status = RegistrationStatus.Approved,
                CabinetId = cabinet.Id,
                RetryAfterSeconds = _options.CheckInIntervalSeconds,
            });
        }

        PendingRegistration? registration = await _db.PendingRegistrations
            .FirstOrDefaultAsync(r => r.MachineId == machineId, ct);

        if (registration is null)
        {
            registration = new PendingRegistration
            {
                MachineId = machineId,
                Hostname = request.Hostname.Trim(),
                OsVersion = request.OsVersion.Trim(),
                AgentVersion = request.AgentVersion.Trim(),
                FirstSeenUtc = nowUtc,
                LastSeenUtc = nowUtc,
                Status = RegistrationStatus.Pending,
            };

            _db.PendingRegistrations.Add(registration);
        }
        else
        {
            registration.Hostname = request.Hostname.Trim();
            registration.OsVersion = request.OsVersion.Trim();
            registration.AgentVersion = request.AgentVersion.Trim();
            registration.LastSeenUtc = nowUtc;

            // A rejected machine that keeps asking stays rejected. Letting it
            // reset itself to Pending would turn a decision into a nuisance the
            // approval queue has to re-make every few minutes.
        }

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.AgentRegister,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.Agent,
            ActorId = machineId,
            Details = new
            {
                registration.Hostname,
                registration.OsVersion,
                registration.AgentVersion,
                Status = registration.Status.ToString(),
            },
        });

        await _db.SaveChangesAsync(ct);

        return Ok(new RegistrationResponse
        {
            Status = registration.Status,
            CabinetId = null,
            RetryAfterSeconds = _options.RegistrationRetrySeconds,
        });
    }

    /// <summary>
    /// Accepts one heartbeat: the small fixed sample, every few minutes.
    /// </summary>
    /// <param name="payload">The sample.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("checkin")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [ProducesResponseType(typeof(CheckInResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public Task<ActionResult<CheckInResponse>> CheckIn(
        [FromBody] CheckInPayload payload,
        CancellationToken ct) => IngestAsync(CheckInTier.Heartbeat, payload, ct);

    /// <summary>
    /// Accepts one full check-in: inventory and SMART, every six hours.
    /// </summary>
    /// <remarks>
    /// The inventory is stored only when its content hash differs from the
    /// version in force. The SMART readings are stored every time, without
    /// exception: this is the failure-prediction series, and a gap in it is a
    /// gap in the prediction.
    /// </remarks>
    /// <param name="payload">The sample.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("checkin/full")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [ProducesResponseType(typeof(CheckInResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public Task<ActionResult<CheckInResponse>> CheckInFull(
        [FromBody] CheckInPayload payload,
        CancellationToken ct) => IngestAsync(CheckInTier.Full, payload, ct);

    /// <summary>
    /// Hands over approved, undispatched, unexpired actions for this cabinet
    /// and only this cabinet, marking them dispatched as it goes.
    /// </summary>
    /// <param name="ct">Cancels the request.</param>
    [HttpGet("actions")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [ProducesResponseType(typeof(IReadOnlyList<ActionRequestDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<IReadOnlyList<ActionRequestDto>>> CollectActions(CancellationToken ct)
    {
        string machineId = RequireMachineId();
        Cabinet? cabinet = await ResolveApprovedCabinetAsync(machineId, AuditEvent.AgentCollectActions, ct);

        if (cabinet is null)
        {
            return ForbidUnapproved();
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        // Scoped to this cabinet by the resolved cabinet id, not by anything
        // the caller sent in the request.
        List<ActionRequest> due = await _db.ActionRequests
            .Where(a => a.CabinetId == cabinet.Id &&
                        a.Status == ActionRequestStatus.Approved &&
                        a.DispatchedUtc == null &&
                        (a.ExpiresUtc == null || a.ExpiresUtc > nowUtc))
            // Approval time is the order. The agent executes a cabinet's
            // actions serially in the order it receives them, so a reboot
            // approved after a service restart must arrive after it.
            .OrderBy(a => a.ApprovedUtc ?? a.RequestedUtc)
            .Take(20)
            .ToListAsync(ct);

        var dispatches = new List<ActionRequestDto>(due.Count);

        foreach (ActionRequest action in due)
        {
            if (!ActionCatalog.TryGet(action.Action, out ActionCatalogEntry entry))
            {
                // An action whose catalog entry has been withdrawn since it was
                // approved is cancelled rather than sent.
                action.Status = ActionRequestStatus.Cancelled;
                action.CompletedUtc = nowUtc;
                continue;
            }

            action.Status = ActionRequestStatus.Dispatched;
            action.DispatchedUtc = nowUtc;

            dispatches.Add(new ActionRequestDto
            {
                Id = action.Id,
                Action = action.Action,
                CabinetId = cabinet.Id,
                Parameters = DeserialiseParameters(action.ParametersJson),
                Reason = action.Reason,
                TicketReference = action.TicketReference,
                RequestedByUserId = action.RequestedByUserId,
                RequestedUtc = action.RequestedUtc,
                ExpiresUtc = action.ExpiresUtc ?? nowUtc.AddSeconds(entry.TimeoutSeconds),
            });

            // Handing an action to a cabinet is the moment the server causes
            // something to happen out there, so this is a Caused record.
            _audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.AgentCollectActions,
                Action = action.Action,
                EventKind = AuditEventKind.Caused,
                Result = AuditResult.Success,
                ActorType = ActorType.Agent,
                ActorId = machineId,
                CabinetId = cabinet.Id,
                CabinetHostname = cabinet.Hostname,
                TargetCabinetId = action.TargetCabinetId,
                TicketReference = action.TicketReference,
                ApprovedByUserId = action.ApprovedByUserId,
                BatchId = action.BatchId,
                Details = new
                {
                    ActionRequestId = action.Id,
                    Action = action.Action.ToString(),
                    action.RequestedByUserId,
                    action.ApprovedByUserId,
                },
            });
        }

        await _db.SaveChangesAsync(ct);

        return Ok(dispatches);
    }

    /// <summary>
    /// Records the outcome of a dispatched action.
    /// </summary>
    /// <remarks>
    /// The request id travels in the body, on the result itself, so that the
    /// envelope the agent received and the envelope it returns are one
    /// contract. A result for an action belonging to a different cabinet is
    /// refused and audited.
    /// </remarks>
    /// <param name="result">The outcome the agent reports.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("actions/result")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> ReportResult(
        [FromBody] ActionResultDto result,
        CancellationToken ct)
    {
        string machineId = RequireMachineId();
        Cabinet? cabinet = await ResolveApprovedCabinetAsync(machineId, AuditEvent.AgentReportResult, ct);

        if (cabinet is null)
        {
            return ForbidUnapproved();
        }

        ActionRequest? action = await _db.ActionRequests
            .FirstOrDefaultAsync(a => a.Id == result.RequestId, ct);

        if (action is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.AgentReportResult,
                "Result for an unknown action request.",
                cabinet.Id,
                new { ActionRequestId = result.RequestId },
                null,
                ct);

            return Problem("Action request not found.", statusCode: StatusCodes.Status404NotFound,
                title: "Not found");
        }

        // One cabinet must never be able to close out another cabinet's work,
        // or to learn that it exists.
        if (action.CabinetId != cabinet.Id)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.AgentReportResult,
                "Result reported for an action belonging to a different cabinet.",
                cabinet.Id,
                new { ActionRequestId = result.RequestId, OwningCabinetId = action.CabinetId },
                action.Action,
                ct);

            return Problem("Action request not found.", statusCode: StatusCodes.Status404NotFound,
                title: "Not found");
        }

        if (action.Status is ActionRequestStatus.Completed)
        {
            // The agent is idempotent per request id, but a retried delivery of
            // a result it already sent is still possible over a flaky link.
            // Acknowledging it is correct; recording a second outcome is not.
            return NoContent();
        }

        if (action.Status is not (ActionRequestStatus.Dispatched or ActionRequestStatus.Approved))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.AgentReportResult,
                $"Result reported for an action in status {action.Status}.",
                cabinet.Id,
                new { ActionRequestId = result.RequestId, Status = action.Status.ToString() },
                action.Action,
                ct);

            return Problem("This action is not awaiting a result.", statusCode: StatusCodes.Status409Conflict,
                title: "Conflict");
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        action.Status = ActionRequestStatus.Completed;
        action.ResultStatus = result.Status;
        action.ResultOutput = Truncate(result.Output, 8000);
        action.ExitCode = result.ExitCode;
        action.StartedUtc = result.StartedAtUtc;
        action.CompletedUtc = result.CompletedAtUtc;
        action.CollectedDataJson = result.CollectedData;

        await RecordLinkProbeAsync(action, result, nowUtc, ct);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.AgentReportResult,
            Action = action.Action,
            // The action ran on the cabinet: state out there changed.
            EventKind = AuditEventKind.Caused,
            Result = result.Status switch
            {
                ActionStatus.Succeeded => AuditResult.Success,
                ActionStatus.Denied => AuditResult.Denied,
                // UnknownResult is not a failure and is not a success. It is
                // recorded as a failure only in the sense that the intended
                // change cannot be claimed — the distinct ActionStatus on the
                // request is what a reader acts on, and nothing retries it.
                _ => AuditResult.Failure,
            },
            ActorType = ActorType.Agent,
            ActorId = machineId,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            TargetCabinetId = action.TargetCabinetId,
            TicketReference = action.TicketReference,
            ApprovedByUserId = action.ApprovedByUserId,
            BatchId = action.BatchId,
            Reason = action.Reason,
            Details = new
            {
                ActionRequestId = action.Id,
                Action = action.Action.ToString(),
                ResultStatus = result.Status.ToString(),
                result.ExitCode,
                result.StartedAtUtc,
                result.CompletedAtUtc,
                action.RequestedByUserId,
                action.ApprovedByUserId,
            },
        });

        await _db.SaveChangesAsync(ct);

        return NoContent();
    }

    private async Task<ActionResult<CheckInResponse>> IngestAsync(
        CheckInTier tier, CheckInPayload payload, CancellationToken ct)
    {
        string machineId = RequireMachineIdMatch(payload.MachineId);
        Cabinet? cabinet = await ResolveApprovedCabinetAsync(machineId, AuditEvent.AgentCheckIn, ct);

        if (cabinet is null)
        {
            return ForbidUnapproved();
        }

        OperationResult<CheckInIngestOutcome> result = await _ingest.IngestAsync(cabinet, tier, payload, ct);

        if (!result.Succeeded)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.AgentCheckIn,
                result.Reason ?? "Check-in rejected.",
                cabinet.Id,
                new { MachineId = machineId },
                null,
                ct);

            return Problem(result);
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        bool hasPending = await _db.ActionRequests
            .AsNoTracking()
            .AnyAsync(a => a.CabinetId == cabinet.Id &&
                           a.Status == ActionRequestStatus.Approved &&
                           a.DispatchedUtc == null &&
                           (a.ExpiresUtc == null || a.ExpiresUtc > nowUtc), ct);

        return Ok(new CheckInResponse
        {
            Accepted = true,
            CabinetId = cabinet.Id,
            ReceivedUtc = result.Value!.ReceivedUtc,
            WasDuplicate = result.Value.WasDuplicate,
            InventoryUnchanged = result.Value.InventoryUnchanged,
            NextHeartbeatSeconds = _options.CheckInIntervalSeconds,
            NextFullCheckInSeconds = _options.FullCheckInIntervalSeconds,
            HasPendingActions = hasPending,
        });
    }

    /// <summary>
    /// Turns a ping result into the reachability fact the cabinet detail view
    /// shows. Reachable from the server is not the same question.
    /// </summary>
    private async Task RecordLinkProbeAsync(
        ActionRequest action, ActionResultDto result, DateTimeOffset nowUtc, CancellationToken ct)
    {
        if (action.TargetCabinetId is not { } targetId || action.Action != ActionName.PingCabinet)
        {
            return;
        }

        CabinetLinkProbe? probe = await _db.CabinetLinkProbes
            .FirstOrDefaultAsync(p => p.SourceCabinetId == action.CabinetId && p.TargetCabinetId == targetId, ct);

        if (probe is null)
        {
            probe = new CabinetLinkProbe
            {
                SourceCabinetId = action.CabinetId,
                TargetCabinetId = targetId,
            };

            _db.CabinetLinkProbes.Add(probe);
        }

        probe.ObservedUtc = nowUtc;
        probe.Reachable = result.Status == ActionStatus.Succeeded;
        probe.LatencyMs = ParseLatency(result.Output);
    }

    /// <summary>
    /// Reads the round-trip time out of a ping executor's own output line.
    /// </summary>
    /// <remarks>
    /// The output is agent-produced text and is treated as such: a value that
    /// does not parse leaves the latency null rather than defaulting to zero,
    /// which would read as an instant reply.
    /// </remarks>
    private static double? ParseLatency(string? output)
    {
        if (string.IsNullOrWhiteSpace(output))
        {
            return null;
        }

        const string marker = "roundTripMs=";
        int start = output.IndexOf(marker, StringComparison.OrdinalIgnoreCase);

        if (start < 0)
        {
            return null;
        }

        ReadOnlySpan<char> tail = output.AsSpan(start + marker.Length);
        int end = 0;

        while (end < tail.Length && (char.IsDigit(tail[end]) || tail[end] == '.'))
        {
            end++;
        }

        return double.TryParse(
            tail[..end], System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out double value)
            ? value
            : null;
    }

    private async Task<Cabinet?> ResolveApprovedCabinetAsync(
        string machineId, AuditEvent auditEvent, CancellationToken ct)
    {
        Cabinet? cabinet = await _db.Cabinets.FirstOrDefaultAsync(c => c.MachineId == machineId, ct);

        if (cabinet is { IsActive: true })
        {
            return cabinet;
        }

        string reason = cabinet is null
            ? "Request from a machine that is not an approved cabinet."
            : "Request from a deactivated cabinet.";

        await _audit.WriteDenialAsync(
            auditEvent, reason, cabinet?.Id, new { MachineId = machineId }, null, ct);

        return null;
    }

    /// <summary>
    /// Deliberately identical for "never approved" and "deactivated": an
    /// unapproved agent learns nothing about the fleet from the shape of its
    /// refusal.
    /// </summary>
    private ObjectResult ForbidUnapproved() =>
        Problem(
            "This machine is not an approved, active cabinet.",
            statusCode: StatusCodes.Status403Forbidden,
            title: "Forbidden");

    /// <summary>
    /// The machine identity established by the authenticator — never a value
    /// read out of the request body.
    /// </summary>
    private string RequireMachineId() =>
        User.GetAgentMachineId()
        ?? throw new InvalidOperationException("Agent principal carries no machine id.");

    /// <summary>
    /// Where a payload also names a machine, it must name the same one the
    /// authenticated header did. A mismatch is a rejected request, never a
    /// quiet preference for one value over the other.
    /// </summary>
    private string RequireMachineIdMatch(string? bodyMachineId)
    {
        string authenticated = RequireMachineId();

        if (!string.IsNullOrWhiteSpace(bodyMachineId) &&
            !string.Equals(bodyMachineId.Trim(), authenticated, StringComparison.Ordinal))
        {
            throw new AgentMachineIdMismatchException();
        }

        return authenticated;
    }

    private static IReadOnlyDictionary<string, string> DeserialiseParameters(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json, ContractJson.Default)
                   ?? new Dictionary<string, string>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>();
        }
    }

    private static string? Truncate(string? value, int max) =>
        value is null || value.Length <= max ? value : value[..max];
}

/// <summary>
/// Raised when an agent's payload claims a different machine than its
/// authenticated identity. Handled as a 400 by the global handler.
/// </summary>
public sealed class AgentMachineIdMismatchException : Exception
{
    /// <summary>Creates the exception.</summary>
    public AgentMachineIdMismatchException()
        : base("The machine id in the request body does not match the authenticated agent.") { }
}
