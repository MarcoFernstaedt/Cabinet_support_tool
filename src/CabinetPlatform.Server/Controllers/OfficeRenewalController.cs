using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.ComponentModel.DataAnnotations;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Manual repeat-session grant for one already approved office lab device.</summary>
[ApiController]
[Route("api/office/enroll/renew")]
public sealed class OfficeRenewalController(OfficeEnrollmentStore store, SupportDbContext db, IAuditService audit) : SupportControllerBase
{
    [HttpPost("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [RequestSizeLimit(2048)]
    public async Task<IActionResult> Renew(Guid id, [FromBody] OfficeRenewalRequest request, CancellationToken ct)
    {
        if (!store.Enabled) return NotFound();
        if (request.RequestId == Guid.Empty || string.IsNullOrWhiteSpace(request.Reason))
            return BadRequest("A unique request id and reason are required.");
        // Retirement uses the same cabinet row write lock. Do not write a grant
        // while another request withdraws this device's approval.
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var active = await db.Cabinets.Where(c => c.Id == id && c.IsActive)
            .ExecuteUpdateAsync(set => set.SetProperty(c => c.IsActive, c => c.IsActive), ct);
        if (active == 0) return Conflict("Cabinet is not active or does not exist.");
        var machineId = await db.Cabinets.AsNoTracking().Where(c => c.Id == id)
            .Select(c => c.MachineId).SingleAsync(ct);
        audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.RenewOfficeDevice, EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success, ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(), ActorDisplayName = CurrentUser.Username,
            CabinetId = id, Reason = request.Reason.Trim(),
            Details = new { request.RequestId, MachineId = machineId }
        });
        // The SQL audit write is provisional until the journal write succeeds.
        await db.SaveChangesAsync(ct);
        var expires = store.Renew(machineId, request.RequestId, CurrentUser.UserId.ToString(), request.Reason.Trim());
        if (expires is null) return Conflict("No eligible existing office credential or request id conflict.");
        // The journal contains the grant and its attribution in one atomic replace.
        // A lost response can repeat this request without extending it.
        await transaction.CommitAsync(ct);
        return Ok(new { CabinetId = id, MachineId = machineId, RequestId = request.RequestId, ExpiresUtc = expires });
    }
}

public sealed class OfficeRenewalRequest
{
    public Guid RequestId { get; set; }
    [Required, StringLength(500, MinimumLength = 1)]
    public string Reason { get; set; } = "";
}
