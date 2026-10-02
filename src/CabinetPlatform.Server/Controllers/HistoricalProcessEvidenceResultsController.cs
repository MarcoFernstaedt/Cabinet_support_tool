using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Only typed, cabinet and action bound historical process evidence.</summary>
[Route("api/cabinets/{cabinetId:guid}/historical-process-evidence")]
public sealed class HistoricalProcessEvidenceResultsController(SupportDbContext db, IAuditService audit) : SupportControllerBase
{
    [HttpGet("latest")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<HistoricalProcessSavedResult>> Latest(Guid cabinetId, CancellationToken ct) =>
        await Respond(await db.ActionRequests.AsNoTracking()
            .Where(a => a.CabinetId == cabinetId && a.Action == ActionName.GetHistoricalProcessEvidence)
            .OrderByDescending(a => a.RequestedUtc).ThenByDescending(a => a.Id)
            .FirstOrDefaultAsync(ct), cabinetId, ct);

    [HttpGet("{actionId:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<HistoricalProcessSavedResult>> ByAction(Guid cabinetId, Guid actionId, CancellationToken ct) =>
        await Respond(await db.ActionRequests.AsNoTracking().FirstOrDefaultAsync(a =>
            a.Id == actionId && a.CabinetId == cabinetId && a.Action == ActionName.GetHistoricalProcessEvidence, ct), cabinetId, ct);

    private async Task<ActionResult<HistoricalProcessSavedResult>> Respond(ActionRequest? action, Guid cabinetId, CancellationToken ct)
    {
        if (action is null) return NotFound();
        bool completed = action.Status == ActionRequestStatus.Completed;
        bool succeeded = completed && action.ResultStatus == ActionStatus.Succeeded;
        HistoricalProcessEvidenceResult? evidence = null;
        if (succeeded && !HistoricalProcessEvidenceValidator.TryValidate(action.CollectedDataJson,
                action.CompletedUtc ?? DateTimeOffset.MinValue, out evidence))
        {
            await Audit(action, cabinetId, AuditResult.Denied, "invalid", ct);
            return StatusCode(StatusCodes.Status502BadGateway);
        }
        string state = succeeded ? "complete" :
            completed || action.Status is ActionRequestStatus.Denied or ActionRequestStatus.Expired or ActionRequestStatus.Cancelled
                ? "failed" : "pending";
        var response = new HistoricalProcessSavedResult(action.CabinetId, action.Id, state, action.RequestedUtc,
            completed ? action.CompletedUtc : null, evidence);
        if (JsonSerializer.SerializeToUtf8Bytes(response, CabinetPlatform.Contracts.Common.ContractJson.Default).Length > 20480)
        {
            await Audit(action, cabinetId, AuditResult.Denied, "oversized", ct);
            return StatusCode(StatusCodes.Status502BadGateway);
        }
        await Audit(action, cabinetId, AuditResult.Success, state, ct);
        return Ok(response);
    }

    private Task Audit(ActionRequest action, Guid cabinetId, AuditResult result, string state, CancellationToken ct) =>
        audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ListActions, Action = ActionName.GetHistoricalProcessEvidence,
            EventKind = AuditEventKind.Observed, Result = result,
            ActorType = ActorType.User, ActorId = CurrentUser.UserId.ToString(),
            ActorDisplayName = CurrentUser.Username, CabinetId = cabinetId,
            Details = new { ActionRequestId = action.Id, Projection = "HistoricalProcessEvidence", State = state }
        }, ct);
}

public sealed record HistoricalProcessSavedResult(Guid CabinetId, Guid ActionId, string State,
    DateTimeOffset RequestedAtUtc, DateTimeOffset? CompletedAtUtc, HistoricalProcessEvidenceResult? Evidence);
