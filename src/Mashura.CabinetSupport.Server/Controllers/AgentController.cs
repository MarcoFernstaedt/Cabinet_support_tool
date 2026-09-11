using System.Text.Json;
using Mashura.CabinetSupport.Contracts.Agent;
using Mashura.CabinetSupport.Contracts.Enums;
using Mashura.CabinetSupport.Server.Actions;
using Mashura.CabinetSupport.Server.Auditing;
using Mashura.CabinetSupport.Server.Configuration;
using Mashura.CabinetSupport.Server.Data;
using Mashura.CabinetSupport.Server.Domain;
using Mashura.CabinetSupport.Server.Security;
using Mashura.CabinetSupport.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Mashura.CabinetSupport.Server.Controllers;

/// <summary>
/// The agent-facing surface.
///
/// Every action here authenticates through <see cref="IAgentAuthenticator"/>
/// and then — separately — resolves the cabinet from the database and checks
/// that a Supervisor approved it. Presenting a valid agent key proves only
/// that the caller is some agent; it never proves the caller is a cabinet this
/// fleet has admitted.
/// </summary>
[Route("api/agent")]
public sealed class AgentController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly ICheckInIngestService _ingest;
    private readonly AgentIngestOptions _options;
    private readonly TimeProvider _timeProvider;

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
    /// tells the agent to wait. It never returns fleet information, and it
    /// never admits the machine — only a Supervisor does that.
    /// </summary>
    [HttpPost("register")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentRegister)]
    [ProducesResponseType(typeof(AgentRegistrationResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<AgentRegistrationResponse>> Register(
        [FromBody] AgentRegistrationRequest request,
        CancellationToken ct)
    {
        string machineId = RequireMachineIdMatch(request.MachineId);
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        Cabinet? cabinet = await _db.Cabinets
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.MachineId == machineId, ct);

        if (cabinet is not null)
        {
            // Already admitted. Say so without disclosing which clinic, site
            // or department it was filed under.
            await _audit.WriteAsync(new AuditRecord
            {
                Action = AuditActions.AgentRegister,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Success,
                ActorType = ActorTypes.Agent,
                ActorId = machineId,
                CabinetId = cabinet.Id,
                CabinetHostname = cabinet.Hostname,
                Reason = "Agent re-registered an already-approved cabinet."
            }, ct);

            return Ok(new AgentRegistrationResponse
            {
                Status = RegistrationStatus.Approved,
                Message = "This machine is already approved.",
                RetryAfterSeconds = _options.CheckInIntervalSeconds
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
                OsVersion = request.OsVersion?.Trim(),
                AgentVersion = request.AgentVersion?.Trim(),
                FirstSeenUtc = nowUtc,
                LastSeenUtc = nowUtc,
                Status = RegistrationStatus.Pending
            };

            _db.PendingRegistrations.Add(registration);
        }
        else
        {
            registration.Hostname = request.Hostname.Trim();
            registration.OsVersion = request.OsVersion?.Trim();
            registration.AgentVersion = request.AgentVersion?.Trim();
            registration.LastSeenUtc = nowUtc;

            // A rejected machine that keeps asking stays rejected. Letting it
            // reset itself to Pending would turn a decision into a nuisance
            // the approval queue has to re-make every few minutes.
        }

        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.AgentRegister,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.Agent,
            ActorId = machineId,
            Details = new
            {
                registration.Hostname,
                registration.OsVersion,
                registration.AgentVersion,
                Status = registration.Status.ToString()
            }
        });

        await _db.SaveChangesAsync(ct);

        string message = registration.Status switch
        {
            RegistrationStatus.Rejected => "This machine's registration was rejected.",
            _ => "Registration received. Awaiting approval."
        };

        return Ok(new AgentRegistrationResponse
        {
            Status = registration.Status,
            Message = message,
            RetryAfterSeconds = _options.RegistrationRetrySeconds
        });
    }

    /// <summary>
    /// Accepts one observation. Refuses with 403 unless the machine resolves
    /// to an approved, active cabinet — an unapproved agent reports nothing
    /// usable, and the refusal is audited.
    /// </summary>
    [HttpPost("checkin")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [ProducesResponseType(typeof(CheckInResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<CheckInResponse>> CheckIn(
        [FromBody] CheckInRequest request,
        CancellationToken ct)
    {
        string machineId = RequireMachineIdMatch(request.MachineId);

        Cabinet? cabinet = await _db.Cabinets.FirstOrDefaultAsync(c => c.MachineId == machineId, ct);

        if (cabinet is null || !cabinet.IsActive)
        {
            string reason = cabinet is null
                ? "Check-in from a machine that is not an approved cabinet."
                : "Check-in from a deactivated cabinet.";

            await _audit.WriteDenialAsync(
                AuditActions.AgentCheckIn, reason, cabinet?.Id, new { MachineId = machineId }, ct);

            // Deliberately identical for "never approved" and "deactivated":
            // an unapproved agent learns nothing about the fleet from the
            // shape of its refusal.
            return Problem(
                "This machine is not an approved, active cabinet.",
                statusCode: StatusCodes.Status403Forbidden,
                title: "Forbidden");
        }

        OperationResult<CheckInIngestOutcome> result = await _ingest.IngestAsync(cabinet, request, ct);

        if (!result.Succeeded)
        {
            await _audit.WriteDenialAsync(
                AuditActions.AgentCheckIn,
                result.Reason ?? "Check-in rejected.",
                cabinet.Id,
                new { MachineId = machineId },
                ct);

            return Problem(result);
        }

        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        bool hasPending = await _db.ActionRequests
            .AsNoTracking()
            .AnyAsync(a => a.CabinetId == cabinet.Id &&
                           a.Status == ActionRequestStatus.Approved &&
                           a.DispatchedUtc == null &&
                           (a.ExpiresUtc == null || a.ExpiresUtc > nowUtc), ct);

        return Ok(new CheckInResponse
        {
            Accepted = true,
            ReceivedUtc = result.Value!.CheckIn.ReceivedUtc,
            WasDuplicate = result.Value.WasDuplicate,
            NextCheckInSeconds = _options.CheckInIntervalSeconds,
            HasPendingActions = hasPending
        });
    }

    /// <summary>
    /// Hands over approved, undispatched, unexpired actions for this cabinet
    /// and only this cabinet, marking them dispatched as it goes.
    /// </summary>
    [HttpGet("actions")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [ProducesResponseType(typeof(IReadOnlyList<AgentActionDispatch>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<IReadOnlyList<AgentActionDispatch>>> CollectActions(
        CancellationToken ct)
    {
        string machineId = RequireMachineId();

        Cabinet? cabinet = await _db.Cabinets
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.MachineId == machineId, ct);

        if (cabinet is null || !cabinet.IsActive)
        {
            await _audit.WriteDenialAsync(
                AuditActions.AgentCollectActions,
                "Action poll from a machine that is not an approved, active cabinet.",
                cabinet?.Id,
                new { MachineId = machineId },
                ct);

            return Problem(
                "This machine is not an approved, active cabinet.",
                statusCode: StatusCodes.Status403Forbidden,
                title: "Forbidden");
        }

        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        // Scoped to this cabinet by the resolved cabinet id, not by anything
        // the caller sent in the request.
        List<ActionRequest> due = await _db.ActionRequests
            .Where(a => a.CabinetId == cabinet.Id &&
                        a.Status == ActionRequestStatus.Approved &&
                        a.DispatchedUtc == null &&
                        (a.ExpiresUtc == null || a.ExpiresUtc > nowUtc))
            .OrderBy(a => a.RequestedUtc)
            .Take(20)
            .ToListAsync(ct);

        var dispatches = new List<AgentActionDispatch>(due.Count);

        foreach (ActionRequest action in due)
        {
            if (!ActionCatalog.TryGet(action.Action, out ActionCatalogEntry entry))
            {
                // An action whose catalogue entry has been withdrawn since it
                // was approved is cancelled rather than sent.
                action.Status = ActionRequestStatus.Cancelled;
                action.CompletedUtc = nowUtc;
                continue;
            }

            action.Status = ActionRequestStatus.Dispatched;
            action.DispatchedUtc = nowUtc;

            dispatches.Add(new AgentActionDispatch
            {
                ActionRequestId = action.Id,
                Action = action.Action,
                Parameters = DeserialiseParameters(action.ParametersJson),
                TimeoutSeconds = entry.TimeoutSeconds,
                ExpiresUtc = action.ExpiresUtc ?? nowUtc.AddSeconds(entry.TimeoutSeconds),
                DispatchedUtc = nowUtc
            });

            // Handing an action to a cabinet is the moment the server causes
            // something to happen out there, so this is a Caused record.
            _audit.Enqueue(new AuditRecord
            {
                Action = AuditActions.AgentCollectActions,
                EventKind = AuditEventKind.Caused,
                Result = AuditResult.Success,
                ActorType = ActorTypes.Agent,
                ActorId = machineId,
                CabinetId = cabinet.Id,
                CabinetHostname = cabinet.Hostname,
                TicketReference = action.TicketReference,
                ApprovedByUserId = action.ApprovedByUserId,
                Details = new
                {
                    ActionRequestId = action.Id,
                    Action = action.Action.ToString(),
                    RequestedByUserId = action.RequestedByUserId,
                    action.ApprovedByUserId
                }
            });
        }

        await _db.SaveChangesAsync(ct);

        return Ok(dispatches);
    }

    /// <summary>
    /// Records the outcome of a dispatched action. A result for an action
    /// belonging to a different cabinet is refused and audited.
    /// </summary>
    [HttpPost("actions/{id:guid}/result")]
    [Authorize(AuthenticationSchemes = AgentAuthenticationHandler.SchemeName,
        Policy = AuthorizationPolicies.RequireAgent)]
    [EnableRateLimiting(RateLimitPolicies.AgentCheckIn)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> ReportResult(
        Guid id,
        [FromBody] AgentActionResultRequest request,
        CancellationToken ct)
    {
        string machineId = RequireMachineId();

        Cabinet? cabinet = await _db.Cabinets
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.MachineId == machineId, ct);

        if (cabinet is null || !cabinet.IsActive)
        {
            await _audit.WriteDenialAsync(
                AuditActions.AgentReportResult,
                "Result from a machine that is not an approved, active cabinet.",
                cabinet?.Id,
                new { MachineId = machineId, ActionRequestId = id },
                ct);

            return Problem(
                "This machine is not an approved, active cabinet.",
                statusCode: StatusCodes.Status403Forbidden,
                title: "Forbidden");
        }

        ActionRequest? action = await _db.ActionRequests.FirstOrDefaultAsync(a => a.Id == id, ct);

        if (action is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.AgentReportResult,
                "Result for an unknown action request.",
                cabinet.Id,
                new { ActionRequestId = id },
                ct);

            return Problem(
                "Action request not found.",
                statusCode: StatusCodes.Status404NotFound,
                title: "Not found");
        }

        // One cabinet must never be able to close out another cabinet's work,
        // or to learn that it exists.
        if (action.CabinetId != cabinet.Id)
        {
            await _audit.WriteDenialAsync(
                AuditActions.AgentReportResult,
                "Result reported for an action belonging to a different cabinet.",
                cabinet.Id,
                new { ActionRequestId = id, OwningCabinetId = action.CabinetId },
                ct);

            return Problem(
                "Action request not found.",
                statusCode: StatusCodes.Status404NotFound,
                title: "Not found");
        }

        if (action.Status is not (ActionRequestStatus.Dispatched or ActionRequestStatus.Approved))
        {
            await _audit.WriteDenialAsync(
                AuditActions.AgentReportResult,
                $"Result reported for an action in status {action.Status}.",
                cabinet.Id,
                new { ActionRequestId = id, Status = action.Status.ToString() },
                ct);

            return Problem(
                "This action is not awaiting a result.",
                statusCode: StatusCodes.Status409Conflict,
                title: "Conflict");
        }

        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        action.Status = ActionRequestStatus.Completed;
        action.ResultStatus = request.Status;
        action.ResultOutput = Truncate(request.Output, 8000);
        action.CompletedUtc = nowUtc;

        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.AgentReportResult,
            // The action ran on the cabinet: state out there changed.
            EventKind = AuditEventKind.Caused,
            Result = request.Status == ActionResultStatus.Succeeded
                ? AuditResult.Success
                : AuditResult.Failure,
            ActorType = ActorTypes.Agent,
            ActorId = machineId,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            TicketReference = action.TicketReference,
            ApprovedByUserId = action.ApprovedByUserId,
            Reason = action.Reason,
            Details = new
            {
                ActionRequestId = action.Id,
                Action = action.Action.ToString(),
                ResultStatus = request.Status.ToString(),
                request.ExitCode,
                request.StartedUtc,
                request.CompletedUtc,
                RequestedByUserId = action.RequestedByUserId,
                action.ApprovedByUserId
            }
        });

        await _db.SaveChangesAsync(ct);

        return NoContent();
    }

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

    private static Dictionary<string, string> DeserialiseParameters(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json, Contracts.Common.ContractJson.Default)
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
    public AgentMachineIdMismatchException()
        : base("The machine id in the request body does not match the authenticated agent.") { }
}
