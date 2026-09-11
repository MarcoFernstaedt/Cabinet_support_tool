using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Registrations;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

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
            Event = AuditEvent.ListPendingRegistrations,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
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
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        PendingRegistration? registration =
            await _db.PendingRegistrations.FirstOrDefaultAsync(r => r.Id == id, ct);

        if (registration is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ApproveRegistration, "Registration not found.", null,
                new { RegistrationId = id }, cancellationToken: ct);
            return Problem("Registration not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (registration.Status != RegistrationStatus.Pending)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ApproveRegistration,
                $"Registration is already {registration.Status}.", null,
                new { RegistrationId = id }, cancellationToken: ct);
            return Problem($"This registration is already {registration.Status}.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        if (await _db.Cabinets.AnyAsync(c => c.MachineId == registration.MachineId, ct))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ApproveRegistration,
                "A cabinet already exists for this machine id.", null,
                new { RegistrationId = id, registration.MachineId }, cancellationToken: ct);
            return Problem("A cabinet already exists for this machine.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        if (request.Role is CabinetRole.Unknown)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ApproveRegistration,
                "Approval did not name the cabinet's role in its site.", null,
                new { RegistrationId = id }, cancellationToken: ct);
            return Problem(
                "A cabinet's role in its site must be set at approval: Sync, Satellite or Standalone.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        Site site = await ResolveSiteAsync(request.ClientName.Trim(), request.SiteName.Trim(), ct);

        if (request.Role is CabinetRole.Sync && site.SyncCabinetId is not null)
        {
            // A site has exactly one sync cabinet. Admitting a second as Sync
            // would silently demote the first, which is a decision somebody
            // has to make deliberately.
            await _audit.WriteDenialAsync(
                AuditEvent.ApproveRegistration,
                "Site already has a sync cabinet.", null,
                new { RegistrationId = id, SiteId = site.Id }, cancellationToken: ct);
            return Problem(
                "This site already has a sync cabinet. Admit this machine as a satellite, or demote the "
                + "current sync cabinet first.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        var cabinet = new Cabinet
        {
            MachineId = registration.MachineId,
            Hostname = registration.Hostname,
            SiteId = site.Id,
            Role = request.Role,
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

        if (request.Role is CabinetRole.Sync)
        {
            site.SyncCabinetId = cabinet.Id;
        }

        registration.Status = RegistrationStatus.Approved;
        registration.DecidedByUserId = actor.UserId;
        registration.DecidedUtc = nowUtc;

        // Admitting a machine changes what the fleet will act on, so it is a
        // Caused event rather than a mere observation.
        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.ApproveRegistration,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
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
                ClientName = site.Client!.Name,
                SiteName = site.Name,
                SiteId = site.Id,
                Role = cabinet.Role.ToString(),
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
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        PendingRegistration? registration =
            await _db.PendingRegistrations.FirstOrDefaultAsync(r => r.Id == id, ct);

        if (registration is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.RejectRegistration, "Registration not found.", null,
                new { RegistrationId = id }, cancellationToken: ct);
            return Problem("Registration not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (registration.Status != RegistrationStatus.Pending)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.RejectRegistration,
                $"Registration is already {registration.Status}.", null,
                new { RegistrationId = id }, cancellationToken: ct);
            return Problem($"This registration is already {registration.Status}.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        registration.Status = RegistrationStatus.Rejected;
        registration.DecidedByUserId = actor.UserId;
        registration.DecidedUtc = nowUtc;

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.RejectRegistration,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
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

    /// <summary>
    /// Finds or creates the client and site a Supervisor named at approval.
    /// </summary>
    /// <remarks>
    /// The hierarchy grows from approvals rather than from a separate
    /// administration screen, because that is when a human actually knows which
    /// clinic a machine belongs to. Names come from the Supervisor and never
    /// from the agent: a cabinet must not be able to claim the clinic it
    /// serves.
    /// </remarks>
    private async Task<Site> ResolveSiteAsync(string clientName, string siteName, CancellationToken ct)
    {
        Client? client = await _db.Clients.FirstOrDefaultAsync(c => c.Name == clientName, ct);

        if (client is null)
        {
            client = new Client { Name = clientName };
            _db.Clients.Add(client);
        }

        Site? site = await _db.Sites
            .Include(s => s.Client)
            .FirstOrDefaultAsync(s => s.ClientId == client.Id && s.Name == siteName, ct);

        if (site is null)
        {
            site = new Site { ClientId = client.Id, Client = client, Name = siteName };
            _db.Sites.Add(site);
        }

        return site;
    }
}
