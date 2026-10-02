using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Cabinet and action bound, read-only saved display observation.</summary>
[Route("api/cabinets/{cabinetId:guid}/display-results")]
public sealed class DisplayResultsController(SupportDbContext db, IAuditService audit) : SupportControllerBase
{
    [HttpGet("latest")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<DisplaySavedResult>> Latest(Guid cabinetId, CancellationToken ct) =>
        await Respond(await db.ActionRequests.AsNoTracking()
            .Where(a => a.CabinetId == cabinetId && a.Action == ActionName.GetDisplayDiagnostics)
            .OrderByDescending(a => a.RequestedUtc).ThenByDescending(a => a.Id)
            .FirstOrDefaultAsync(ct), cabinetId, ct);

    [HttpGet("{actionId:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<DisplaySavedResult>> ByAction(Guid cabinetId, Guid actionId, CancellationToken ct) =>
        await Respond(await db.ActionRequests.AsNoTracking().FirstOrDefaultAsync(a =>
            a.Id == actionId && a.CabinetId == cabinetId && a.Action == ActionName.GetDisplayDiagnostics, ct), cabinetId, ct);

    private async Task<ActionResult<DisplaySavedResult>> Respond(ActionRequest? action, Guid cabinetId, CancellationToken ct)
    {
        if (action is null) return NotFound();
        bool completed = action.Status == ActionRequestStatus.Completed;
        bool succeeded = completed && action.ResultStatus == ActionStatus.Succeeded;
        DisplayDiagnostics? display = null;
        if (succeeded && !DisplayResultValidator.TryValidate(action.CollectedDataJson, out display))
        {
            await audit.WriteAsync(new AuditRecord
            {
                Event = AuditEvent.ListActions,
                Action = ActionName.GetDisplayDiagnostics,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Denied,
                ActorType = ActorType.User,
                ActorId = CurrentUser.UserId.ToString(),
                ActorDisplayName = CurrentUser.Username,
                CabinetId = cabinetId,
                Details = new { ActionRequestId = action.Id, Projection = "DisplayDiagnostics", Reason = "Invalid saved observation" }
            }, ct);
            return StatusCode(StatusCodes.Status502BadGateway);
        }
        string state = succeeded ? "complete" :
            completed || action.Status is ActionRequestStatus.Denied or ActionRequestStatus.Expired or ActionRequestStatus.Cancelled
                ? "failed" : "pending";
        var result = new DisplaySavedResult(action.CabinetId, action.Id, state, action.RequestedUtc,
            completed ? action.CompletedUtc : null, display);
        if (JsonSerializer.SerializeToUtf8Bytes(result, CabinetPlatform.Contracts.Common.ContractJson.Default).Length > 8192)
            return StatusCode(StatusCodes.Status502BadGateway);
        await audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ListActions,
            Action = ActionName.GetDisplayDiagnostics,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(),
            ActorDisplayName = CurrentUser.Username,
            CabinetId = cabinetId,
            Details = new { ActionRequestId = action.Id, Projection = "DisplayDiagnostics", State = state }
        }, ct);
        return Ok(result);
    }
}

public sealed record DisplaySavedResult(
    Guid CabinetId, Guid ActionId, string State, DateTimeOffset RequestedAtUtc,
    DateTimeOffset? CompletedAtUtc, DisplayDiagnostics? Display);
