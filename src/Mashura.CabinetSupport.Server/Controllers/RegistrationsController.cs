using Mashura.CabinetSupport.Contracts.Common;
using Mashura.CabinetSupport.Contracts.Enums;
using Mashura.CabinetSupport.Contracts.Registrations;
using Mashura.CabinetSupport.Server.Auditing;
using Mashura.CabinetSupport.Server.Data;
using Mashura.CabinetSupport.Server.Domain;
using Mashura.CabinetSupport.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Mashura.CabinetSupport.Server.Controllers;

/// <summary>
/// The gate between "a machine that says it is a cabinet" and "a cabinet".
/// Supervisor only, end to end.
/// </summary>
[Route("api/registrations")]
public sealed class RegistrationsController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly TimeProvider _timeProvider;

    public RegistrationsController(
        SupportDbContext db, IAuditService audit, TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _timeProvider = timeProvider;
    }

    [HttpGet("pending")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(PagedResult<PendingRegistrationDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<PendingRegistrationDto>>> Pending(
        [FromQuery] RegistrationQuery query, CancellationToken ct)
    {
        RegistrationStatus status = query.Status ?? RegistrationStatus.Pending;

        IQueryable<PendingRegistration> rows = _db.PendingRegistrations
            .AsNoTracking()
            .Where(r => r.Status == status);

        int total = await rows.CountAsync(ct);

        List<PendingRegistrationDto> items = await rows
            .OrderBy(r => r.FirstSeenUtc)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .Select(r => new PendingRegistrationDto
            {
                Id = r.Id,
                MachineId = r.MachineId,
                Hostname = r.Hostname,
                OsVersion = r.OsVersion,
                AgentVersion = r.AgentVersion,
                FirstSeenUtc = r.FirstSeenUtc,
                LastSeenUtc = r.LastSeenUtc,
                Status = r.Status,
                DecidedByUserId = r.DecidedByUserId,
                DecidedUtc = r.DecidedUtc
            })
            .ToListAsync(ct);

        CurrentUser actor = CurrentUser;

        await _audit.WriteAsync(new AuditRecord
        {
            Action = AuditActions.ListPendingRegistrations,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = new { Status = status.ToString(), ResultCount = items.Count }
        }, ct);

        return Ok(PagedResult<PendingRegistrationDto>.Create(items, query.Page, query.PageSize, total));
    }

    /// <summary>
    /// Admits a machine to the fleet and files it under a client, site and
    /// department chosen here — by the Supervisor, never by the agent. An
    /// agent must not be able to name the clinic it claims to serve.
    /// </summary>
    [HttpPost("{id:guid}/approve")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(PendingRegistrationDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<PendingRegistrationDto>> Approve(
        Guid id, [FromBody] ApproveRegistrationRequest request, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        PendingRegistration? registration =
            await _db.PendingRegistrations.FirstOrDefaultAsync(r => r.Id == id, ct);

        if (registration is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.ApproveRegistration, "Registration not found.", null,
                new { RegistrationId = id }, ct);
            return Problem("Registration not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (registration.Status != RegistrationStatus.Pending)
        {
            await _audit.WriteDenialAsync(
                AuditActions.ApproveRegistration,
                $"Registration is already {registration.Status}.", null,
                new { RegistrationId = id }, ct);
            return Problem($"This registration is already {registration.Status}.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        if (await _db.Cabinets.AnyAsync(c => c.MachineId == registration.MachineId, ct))
        {
            await _audit.WriteDenialAsync(
                AuditActions.ApproveRegistration,
                "A cabinet already exists for this machine id.", null,
                new { RegistrationId = id, registration.MachineId }, ct);
            return Problem("A cabinet already exists for this machine.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        var cabinet = new Cabinet
        {
            MachineId = registration.MachineId,
            Hostname = registration.Hostname,
            ClientName = request.ClientName.Trim(),
            SiteName = request.SiteName.Trim(),
            DepartmentName = string.IsNullOrWhiteSpace(request.DepartmentName)
                ? null : request.DepartmentName.Trim(),
            Model = string.IsNullOrWhiteSpace(request.Model) ? null : request.Model.Trim(),
            SerialNumber = string.IsNullOrWhiteSpace(request.SerialNumber)
                ? null : request.SerialNumber.Trim(),
            AgentVersion = registration.AgentVersion,
            ApprovedUtc = nowUtc,
            ApprovedByUserId = actor.UserId,
            IsActive = true
        };

        _db.Cabinets.Add(cabinet);

        registration.Status = RegistrationStatus.Approved;
        registration.DecidedByUserId = actor.UserId;
        registration.DecidedUtc = nowUtc;

        // Admitting a machine changes what the fleet will act on, so it is a
        // Caused event rather than a mere observation.
        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.ApproveRegistration,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? null : request.TicketReference.Trim(),
            ApprovedByUserId = actor.UserId,
            Details = new
            {
                RegistrationId = registration.Id,
                cabinet.MachineId,
                cabinet.ClientName,
                cabinet.SiteName,
                cabinet.DepartmentName
            }
        });

        await _db.SaveChangesAsync(ct);

        return Ok(new PendingRegistrationDto
        {
            Id = registration.Id,
            MachineId = registration.MachineId,
            Hostname = registration.Hostname,
            OsVersion = registration.OsVersion,
            AgentVersion = registration.AgentVersion,
            FirstSeenUtc = registration.FirstSeenUtc,
            LastSeenUtc = registration.LastSeenUtc,
            Status = registration.Status,
            DecidedByUserId = registration.DecidedByUserId,
            DecidedUtc = registration.DecidedUtc
        });
    }

    [HttpPost("{id:guid}/reject")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult> Reject(
        Guid id, [FromBody] RejectRegistrationRequest request, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        PendingRegistration? registration =
            await _db.PendingRegistrations.FirstOrDefaultAsync(r => r.Id == id, ct);

        if (registration is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.RejectRegistration, "Registration not found.", null,
                new { RegistrationId = id }, ct);
            return Problem("Registration not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (registration.Status != RegistrationStatus.Pending)
        {
            await _audit.WriteDenialAsync(
                AuditActions.RejectRegistration,
                $"Registration is already {registration.Status}.", null,
                new { RegistrationId = id }, ct);
            return Problem($"This registration is already {registration.Status}.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        registration.Status = RegistrationStatus.Rejected;
        registration.DecidedByUserId = actor.UserId;
        registration.DecidedUtc = nowUtc;

        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.RejectRegistration,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Reason = request.Reason.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? null : request.TicketReference.Trim(),
            Details = new { RegistrationId = registration.Id, registration.MachineId }
        });

        await _db.SaveChangesAsync(ct);

        return NoContent();
    }
}
