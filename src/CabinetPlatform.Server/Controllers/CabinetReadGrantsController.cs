using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Staff-only, exact user/cabinet demo read provisioning. Not exposed by the BFF.</summary>
[Route("api/users/{userId:guid}/cabinet-read-grants/{cabinetId:guid}")]
public sealed class CabinetReadGrantsController(SupportDbContext db, IAuditService audit) : SupportControllerBase
{
    [HttpPut]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    public Task<IActionResult> Grant(Guid userId, Guid cabinetId, [FromBody] CabinetReadDecision request, CancellationToken ct) =>
        Decide(userId, cabinetId, request, grant: true, ct);

    [HttpDelete]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    public Task<IActionResult> Revoke(Guid userId, Guid cabinetId, [FromBody] CabinetReadDecision request, CancellationToken ct) =>
        Decide(userId, cabinetId, request, grant: false, ct);

    private async Task<IActionResult> Decide(Guid userId, Guid cabinetId, CabinetReadDecision request, bool grant, CancellationToken ct)
    {
        AuditEvent eventName = grant ? AuditEvent.GrantCabinetRead : AuditEvent.RevokeCabinetRead;
        if (userId == Guid.Empty || cabinetId == Guid.Empty ||
            string.IsNullOrWhiteSpace(request.Reason) || request.Reason.Length > 2000 ||
            request.TicketReference?.Length > 64)
        {
            await audit.WriteDenialAsync(eventName, "Invalid pair or reason.", cabinetId,
                new { TargetUserId = userId }, cancellationToken: ct);
            return BadRequest();
        }

        // Lock the exact target rows before checking eligibility and presence. The
        // user lock also serializes concurrent decisions on the same pair; no stale
        // preflight lookup may authorize a later insert after deactivation.
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        int userReserved = await db.Users.Where(u => u.Id == userId &&
            (!grant || (u.IsActive && !u.MustChangePassword)))
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.IsActive, u => u.IsActive), ct);
        int cabinetReserved = userReserved == 1
            ? await db.Cabinets.Where(c => c.Id == cabinetId && (!grant || c.IsActive))
                .ExecuteUpdateAsync(s => s.SetProperty(c => c.IsActive, c => c.IsActive), ct)
            : 0;
        if (userReserved != 1 || cabinetReserved != 1)
        {
            await audit.WriteDenialAsync(eventName, "User or cabinet is unavailable.", cabinetId,
                new { TargetUserId = userId }, cancellationToken: ct);
            await transaction.CommitAsync(ct);
            return NotFound();
        }

        bool exists = await db.CabinetReadGrants.AsNoTracking()
            .AnyAsync(g => g.UserId == userId && g.CabinetId == cabinetId, ct);
        if (grant && !exists)
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = userId, CabinetId = cabinetId });
        if (!grant && exists)
            await db.CabinetReadGrants.Where(g => g.UserId == userId && g.CabinetId == cabinetId)
                .ExecuteDeleteAsync(ct);

        if (grant != exists)
        {
            var actor = CurrentUser;
            audit.Enqueue(new AuditRecord
            {
                Event = eventName,
                EventKind = AuditEventKind.Caused,
                Result = AuditResult.Success,
                ActorType = ActorType.User,
                ActorId = actor.UserId.ToString(),
                ActorDisplayName = actor.Username,
                CabinetId = cabinetId,
                Reason = request.Reason.Trim(),
                TicketReference = request.TicketReference?.Trim(),
                Details = new { TargetUserId = userId }
            });
            await db.SaveChangesAsync(ct);
        }
        await transaction.CommitAsync(ct);
        return NoContent();
    }
}

/// <summary>A human justification for one exact grant or withdrawal.</summary>
public sealed record CabinetReadDecision(string Reason, string? TicketReference);
