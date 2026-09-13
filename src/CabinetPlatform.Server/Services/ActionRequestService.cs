using System.Globalization;
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
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Services;

/// <summary>Creating, approving and refusing actions, singly and in batches.</summary>
public interface IActionRequestService
{
    /// <summary>Raises one action against one cabinet.</summary>
    /// <param name="actor">The caller, resolved from their token.</param>
    /// <param name="request">What they asked for.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<ActionRequest>> CreateAsync(
        CurrentUser actor, CreateActionRequest request, CancellationToken ct);

    /// <summary>Approves one action.</summary>
    /// <param name="actor">The approver.</param>
    /// <param name="actionId">The action to approve.</param>
    /// <param name="request">The approver's note.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<ActionRequest>> ApproveAsync(
        CurrentUser actor, Guid actionId, ApproveActionRequest request, CancellationToken ct);

    /// <summary>Refuses one action.</summary>
    /// <param name="actor">The approver.</param>
    /// <param name="actionId">The action to refuse.</param>
    /// <param name="request">Why.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<ActionRequest>> DenyAsync(
        CurrentUser actor, Guid actionId, DenyActionRequest request, CancellationToken ct);

    /// <summary>Raises one action across an explicit list of cabinets.</summary>
    /// <param name="actor">The caller.</param>
    /// <param name="request">The action, its parameters and its frozen targets.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<BatchActionRequest>> CreateBatchAsync(
        CurrentUser actor, CreateBatchActionRequest request, CancellationToken ct);

    /// <summary>Approves a batch and expands it into one request per cabinet.</summary>
    /// <param name="actor">The approver.</param>
    /// <param name="batchId">The batch to approve.</param>
    /// <param name="request">The approver's note.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<BatchActionRequest>> ApproveBatchAsync(
        CurrentUser actor, Guid batchId, ApproveActionRequest request, CancellationToken ct);

    /// <summary>Refuses a batch. Nothing is expanded and nothing is dispatched.</summary>
    /// <param name="actor">The approver.</param>
    /// <param name="batchId">The batch to refuse.</param>
    /// <param name="request">Why.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<BatchActionRequest>> DenyBatchAsync(
        CurrentUser actor, Guid batchId, DenyActionRequest request, CancellationToken ct);
}

/// <summary>
/// Everything that decides whether a catalogued action may run, and who may let
/// it run.
/// </summary>
/// <remarks>
/// The rules that matter are enforced here rather than in a controller, so that
/// there is exactly one path to creating and approving an action and no second,
/// less careful one.
/// </remarks>
public sealed class ActionRequestService : IActionRequestService
{
    private readonly SupportDbContext _db;
    private readonly IActionParameterValidator _parameterValidator;
    private readonly ICabinetClock _clock;
    private readonly IAuditService _audit;
    private readonly IEventLogViewService _eventLogViews;
    private readonly ActionOptions _options;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the service.</summary>
    /// <param name="db">The database.</param>
    /// <param name="parameterValidator">Checks parameters against the catalog.</param>
    /// <param name="clock">Resolves cabinet-local time.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="eventLogViews">Expands a named event log view into its fields.</param>
    /// <param name="options">Action configuration.</param>
    /// <param name="timeProvider">Clock.</param>
    public ActionRequestService(
        SupportDbContext db,
        IActionParameterValidator parameterValidator,
        ICabinetClock clock,
        IAuditService audit,
        IEventLogViewService eventLogViews,
        IOptions<ActionOptions> options,
        TimeProvider timeProvider)
    {
        _db = db;
        _parameterValidator = parameterValidator;
        _clock = clock;
        _audit = audit;
        _eventLogViews = eventLogViews;
        _options = options.Value;
        _timeProvider = timeProvider;
    }

    /// <inheritdoc />
    public async Task<OperationResult<ActionRequest>> CreateAsync(
        CurrentUser actor, CreateActionRequest request, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        // An integer outside the enum can arrive in any JSON body, so the
        // catalog lookup is the gate, not the deserialiser.
        if (!ActionCatalog.TryGet(request.Action, _options, out ActionCatalogEntry entry))
        {
            return await DeniedAsync(
                AuditEvent.RequestAction, actor, null,
                $"Action '{request.Action}' is not in the catalog.",
                OperationResult<ActionRequest>.Invalid("Unknown action."), ct);
        }

        Cabinet? cabinet = await _db.Cabinets
            .Include(c => c.Site)
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == request.CabinetId, ct);

        if (cabinet is null)
        {
            return await DeniedAsync(
                AuditEvent.RequestAction, actor, null,
                "Cabinet not found.",
                OperationResult<ActionRequest>.NotFound("Cabinet not found."), ct);
        }

        OperationResult<PreparedAction> prepared =
            await PrepareAsync(actor, entry, cabinet, request.Parameters, nowUtc,
                request.OverrideSafetyChecks, request.OverrideReason, AuditEvent.RequestAction, ct);

        if (!prepared.Succeeded)
        {
            return Propagate<PreparedAction, ActionRequest>(prepared);
        }

        PreparedAction ready = prepared.Value!;

        var action = new ActionRequest
        {
            Action = entry.Action,
            CabinetId = cabinet.Id,
            TargetCabinetId = ready.TargetCabinetId,
            IsCrossSiteTarget = ready.IsCrossSiteTarget,
            RequestedByUserId = actor.UserId,
            RequestedUtc = nowUtc,
            ParametersJson = JsonSerializer.Serialize(ready.Parameters, ContractJson.Default),
            Reason = request.Reason.Trim(),
            TicketReference = Clean(request.TicketReference),
            SafetyChecksOverridden = ready.OverrideApplied,
            OverrideReason = ready.OverrideApplied ? request.OverrideReason!.Trim() : null,
            Status = entry.RequiresApproval
                ? ActionRequestStatus.PendingApproval
                : ActionRequestStatus.Approved,
        };

        if (!entry.RequiresApproval)
        {
            // No-approval actions are collectable straight away, but they still
            // expire: an uncollected action must not fire hours later.
            action.ExpiresUtc = nowUtc.AddMinutes(_options.UnapprovedActionExpiryMinutes);
        }

        _db.ActionRequests.Add(action);

        // Requesting an action is an intent to change a cabinet, so it is a
        // Caused event even before anything reaches the agent.
        _audit.Enqueue(new AuditRecord
        {
            Event = ready.TargetCabinetId is null
                ? AuditEvent.RequestAction
                : ready.IsCrossSiteTarget
                    ? AuditEvent.CrossSiteCabinetLinkTest
                    : AuditEvent.CabinetLinkTest,
            Action = entry.Action,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            TargetCabinetId = ready.TargetCabinetId,
            TargetCabinetHostname = ready.TargetCabinetHostname,
            Reason = action.Reason,
            TicketReference = action.TicketReference,
            Details = new
            {
                ActionRequestId = action.Id,
                Action = entry.Action.ToString(),
                entry.RequiresApproval,
                entry.IsDisruptive,
                Parameters = ready.Parameters,
                SafetyChecksOverridden = ready.OverrideApplied,
                action.OverrideReason,
                Status = action.Status.ToString(),
                CrossSite = ready.IsCrossSiteTarget,
            },
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult<ActionRequest>.Ok(action);
    }

    /// <inheritdoc />
    public async Task<OperationResult<ActionRequest>> ApproveAsync(
        CurrentUser actor, Guid actionId, ApproveActionRequest request, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        ActionRequest? action = await _db.ActionRequests
            .Include(a => a.Cabinet)
            .FirstOrDefaultAsync(a => a.Id == actionId, ct);

        if (action is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ApproveAction, "Action request not found.", null,
                new { ActionRequestId = actionId }, null, ct);
            return OperationResult<ActionRequest>.NotFound("Action request not found.");
        }

        if (!ActionCatalog.TryGet(action.Action, _options, out ActionCatalogEntry entry))
        {
            return await DeniedAsync(
                AuditEvent.ApproveAction, actor, action.Cabinet,
                "Stored action is no longer in the catalog.",
                OperationResult<ActionRequest>.Conflict(
                    "This action is no longer supported and cannot be approved."), ct);
        }

        // ---------------------------------------------------------------
        // The four-eyes rule. An explicit check, not an assumption that the
        // console hid the button: the person who asked for a disruptive action
        // on a controlled-substance cabinet must never be the person who signs
        // it off.
        // ---------------------------------------------------------------
        if (action.RequestedByUserId == actor.UserId)
        {
            return await DeniedAsync(
                AuditEvent.ApproveAction, actor, action.Cabinet,
                "Approver is the requester; the four-eyes rule refuses self-approval.",
                OperationResult<ActionRequest>.Forbidden(
                    "You cannot approve an action you requested yourself."), ct);
        }

        if (actor.Role < entry.MinimumRole)
        {
            return await DeniedAsync(
                AuditEvent.ApproveAction, actor, action.Cabinet,
                $"Approving {entry.Action} requires {entry.MinimumRole}; caller is {actor.Role}.",
                OperationResult<ActionRequest>.Forbidden(
                    $"Approving {entry.DisplayName} requires the {entry.MinimumRole} role."), ct);
        }

        if (action.Status != ActionRequestStatus.PendingApproval)
        {
            return await DeniedAsync(
                AuditEvent.ApproveAction, actor, action.Cabinet,
                $"Action is {action.Status} and is not awaiting approval.",
                OperationResult<ActionRequest>.Conflict(
                    $"This action is {action.Status} and cannot be approved."), ct);
        }

        if (action.Cabinet is { IsActive: false })
        {
            return await DeniedAsync(
                AuditEvent.ApproveAction, actor, action.Cabinet,
                "Cabinet is no longer active.",
                OperationResult<ActionRequest>.Conflict("Cabinet is not active."), ct);
        }

        action.Status = ActionRequestStatus.Approved;
        action.ApprovedByUserId = actor.UserId;
        action.ApprovedUtc = nowUtc;
        action.ExpiresUtc = nowUtc.AddMinutes(_options.ApprovalExpiryMinutes);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.ApproveAction,
            Action = action.Action,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = action.CabinetId,
            CabinetHostname = action.Cabinet?.Hostname,
            Reason = Clean(request.Note),
            TicketReference = Clean(request.TicketReference) ?? action.TicketReference,
            ApprovedByUserId = actor.UserId,
            BatchId = action.BatchId,
            Details = new
            {
                ActionRequestId = action.Id,
                Action = action.Action.ToString(),
                action.RequestedByUserId,
                action.ExpiresUtc,
            },
        });

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Two approvers pressing Approve at the same instant is the normal
            // case here, not an edge case. The row version means exactly one
            // wins; the other is told plainly rather than having their approval
            // silently overwrite the first. A double-approved action is not
            // representable.
            _db.ChangeTracker.Clear();

            return await DeniedAsync(
                AuditEvent.ApproveAction, actor, action.Cabinet,
                "Approval lost a race with another approver.",
                OperationResult<ActionRequest>.Conflict(
                    "This action was already decided by another approver. Reload it to see the current state."),
                ct);
        }

        return OperationResult<ActionRequest>.Ok(action);
    }

    /// <inheritdoc />
    public async Task<OperationResult<ActionRequest>> DenyAsync(
        CurrentUser actor, Guid actionId, DenyActionRequest request, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        ActionRequest? action = await _db.ActionRequests
            .Include(a => a.Cabinet)
            .FirstOrDefaultAsync(a => a.Id == actionId, ct);

        if (action is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.DenyAction, "Action request not found.", null,
                new { ActionRequestId = actionId }, null, ct);
            return OperationResult<ActionRequest>.NotFound("Action request not found.");
        }

        if (!ActionCatalog.TryGet(action.Action, out ActionCatalogEntry entry))
        {
            return await DeniedAsync(
                AuditEvent.DenyAction, actor, action.Cabinet,
                "Stored action is no longer in the catalog.",
                OperationResult<ActionRequest>.Conflict("This action is no longer supported."), ct);
        }

        if (actor.Role < entry.MinimumRole)
        {
            return await DeniedAsync(
                AuditEvent.DenyAction, actor, action.Cabinet,
                $"Denying {entry.Action} requires {entry.MinimumRole}; caller is {actor.Role}.",
                OperationResult<ActionRequest>.Forbidden(
                    $"Denying {entry.DisplayName} requires the {entry.MinimumRole} role."), ct);
        }

        if (action.Status != ActionRequestStatus.PendingApproval)
        {
            return await DeniedAsync(
                AuditEvent.DenyAction, actor, action.Cabinet,
                $"Action is {action.Status} and is not awaiting approval.",
                OperationResult<ActionRequest>.Conflict(
                    $"This action is {action.Status} and cannot be denied."), ct);
        }

        action.Status = ActionRequestStatus.Denied;
        action.ApprovedByUserId = null;
        action.CompletedUtc = nowUtc;

        // Denying is a decision about a cabinet's state, so it belongs in the
        // Caused stream beside the approvals it sits among.
        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.DenyAction,
            Action = action.Action,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = action.CabinetId,
            CabinetHostname = action.Cabinet?.Hostname,
            Reason = request.Reason.Trim(),
            TicketReference = Clean(request.TicketReference) ?? action.TicketReference,
            BatchId = action.BatchId,
            Details = new
            {
                ActionRequestId = action.Id,
                Action = action.Action.ToString(),
                action.RequestedByUserId,
            },
        });

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();

            return await DeniedAsync(
                AuditEvent.DenyAction, actor, action.Cabinet,
                "Refusal lost a race with another approver.",
                OperationResult<ActionRequest>.Conflict(
                    "This action was already decided by another approver. Reload it to see the current state."),
                ct);
        }

        return OperationResult<ActionRequest>.Ok(action);
    }

    /// <inheritdoc />
    public async Task<OperationResult<BatchActionRequest>> CreateBatchAsync(
        CurrentUser actor, CreateBatchActionRequest request, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        if (!ActionCatalog.TryGet(request.Action, _options, out ActionCatalogEntry entry))
        {
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor,
                $"Action '{request.Action}' is not in the catalog.",
                OperationResult<BatchActionRequest>.Invalid("Unknown action."), ct);
        }

        if (!entry.Batchable)
        {
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor,
                $"{entry.Action} may not be batched.",
                OperationResult<BatchActionRequest>.Invalid(
                    $"{entry.DisplayName} may only be requested one cabinet at a time."), ct);
        }

        IReadOnlyList<Guid> targetIds = request.CabinetIds.Distinct().ToArray();

        if (targetIds.Count == 0)
        {
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor, "Batch named no cabinets.",
                OperationResult<BatchActionRequest>.Invalid("A batch must name at least one cabinet."), ct);
        }

        if (targetIds.Count != request.ConfirmedCabinetCount)
        {
            // The operator confirmed a number on screen. Submitting a different
            // one means they confirmed something other than what they sent.
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor,
                $"Confirmed count {request.ConfirmedCabinetCount} does not match {targetIds.Count} targets.",
                OperationResult<BatchActionRequest>.Invalid(
                    $"You confirmed {request.ConfirmedCabinetCount} cabinets but the request names " +
                    $"{targetIds.Count}. Re-check the list and confirm again."), ct);
        }

        int cap = Math.Min(
            _options.MaximumBatchSize,
            entry.MaximumBatchSize > 0 ? entry.MaximumBatchSize : _options.MaximumBatchSize);

        if (targetIds.Count > cap)
        {
            // Rejected, not truncated. Silently acting on the first hundred of
            // a two-hundred-cabinet request is worse than refusing it.
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor,
                $"Batch of {targetIds.Count} exceeds the cap of {cap} for {entry.Action}.",
                OperationResult<BatchActionRequest>.Invalid(
                    $"A batch of {entry.DisplayName} may name at most {cap} cabinets. " +
                    "Split it into smaller batches."), ct);
        }

        if (actor.Role < entry.MinimumRole)
        {
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor,
                $"{entry.Action} requires {entry.MinimumRole}; caller is {actor.Role}.",
                OperationResult<BatchActionRequest>.Forbidden(
                    $"{entry.DisplayName} requires the {entry.MinimumRole} role."), ct);
        }

        List<Cabinet> cabinets = await _db.Cabinets
            .Include(c => c.Site)
            .Where(c => targetIds.Contains(c.Id))
            .AsNoTracking()
            .ToListAsync(ct);

        if (cabinets.Count != targetIds.Count)
        {
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor,
                "Batch named a cabinet that does not exist.",
                OperationResult<BatchActionRequest>.NotFound(
                    "One or more of the named cabinets does not exist."), ct);
        }

        // Parameters are validated once against the catalog. Per-cabinet
        // checks that depend on a cabinet's own state happen at approval, when
        // the batch actually expands.
        OperationResult<IReadOnlyDictionary<string, string>> parameters =
            _parameterValidator.Validate(entry, request.Parameters, nowUtc);

        if (!parameters.Succeeded)
        {
            return await DeniedBatchAsync(
                AuditEvent.RequestBatchAction, actor,
                parameters.Reason ?? "Parameter validation failed.",
                OperationResult<BatchActionRequest>.Invalid(parameters.Reason!), ct);
        }

        var batch = new BatchActionRequest
        {
            Action = entry.Action,
            ParametersJson = JsonSerializer.Serialize(parameters.Value, ContractJson.Default),
            RequestedByUserId = actor.UserId,
            RequestedUtc = nowUtc,
            Reason = request.Reason.Trim(),
            TicketReference = Clean(request.TicketReference),
            Status = BatchActionStatus.PendingApproval,
            TargetCount = targetIds.Count,
        };

        foreach (Guid cabinetId in targetIds)
        {
            batch.Targets.Add(new BatchActionTarget { BatchId = batch.Id, CabinetId = cabinetId });
        }

        _db.BatchActionRequests.Add(batch);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.RequestBatchAction,
            Action = entry.Action,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Reason = batch.Reason,
            TicketReference = batch.TicketReference,
            BatchId = batch.Id,
            Details = new
            {
                BatchId = batch.Id,
                Action = entry.Action.ToString(),
                batch.TargetCount,
                Parameters = parameters.Value,
                RequiredRole = RequiredBatchApproverRole(entry, targetIds.Count).ToString(),
                CabinetIds = targetIds,
            },
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult<BatchActionRequest>.Ok(batch);
    }

    /// <inheritdoc />
    public async Task<OperationResult<BatchActionRequest>> ApproveBatchAsync(
        CurrentUser actor, Guid batchId, ApproveActionRequest request, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        BatchActionRequest? batch = await _db.BatchActionRequests
            .Include(x => x.Targets)
            .FirstOrDefaultAsync(x => x.Id == batchId, ct);

        if (batch is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ApproveBatchAction, "Batch not found.", null, new { BatchId = batchId }, null, ct);
            return OperationResult<BatchActionRequest>.NotFound("Batch not found.");
        }

        if (!ActionCatalog.TryGet(batch.Action, _options, out ActionCatalogEntry entry))
        {
            return await DeniedBatchAsync(
                AuditEvent.ApproveBatchAction, actor, "Stored action is no longer in the catalog.",
                OperationResult<BatchActionRequest>.Conflict("This action is no longer supported."), ct);
        }

        if (batch.Status != BatchActionStatus.PendingApproval)
        {
            return await DeniedBatchAsync(
                AuditEvent.ApproveBatchAction, actor,
                $"Batch is {batch.Status} and is not awaiting approval.",
                OperationResult<BatchActionRequest>.Conflict(
                    $"This batch is {batch.Status} and cannot be approved."), ct);
        }

        if (batch.RequestedByUserId == actor.UserId)
        {
            return await DeniedBatchAsync(
                AuditEvent.ApproveBatchAction, actor,
                "Approver is the requester; the four-eyes rule refuses self-approval.",
                OperationResult<BatchActionRequest>.Forbidden(
                    "You cannot approve a batch you requested yourself."), ct);
        }

        Role required = RequiredBatchApproverRole(entry, batch.TargetCount);

        if (actor.Role < required)
        {
            // Approval requirements scale with blast radius: the same action
            // across fifty cabinets is a different decision from one cabinet.
            return await DeniedBatchAsync(
                AuditEvent.ApproveBatchAction, actor,
                $"A batch of {batch.TargetCount} {entry.Action} requires {required}; caller is {actor.Role}.",
                OperationResult<BatchActionRequest>.Forbidden(
                    $"A batch of {batch.TargetCount} cabinets for {entry.DisplayName} requires the " +
                    $"{required} role."), ct);
        }

        List<Guid> cabinetIds = batch.Targets.Select(t => t.CabinetId).ToList();

        List<Cabinet> cabinets = await _db.Cabinets
            .Where(c => cabinetIds.Contains(c.Id))
            .AsNoTracking()
            .ToListAsync(ct);

        Dictionary<Guid, Cabinet> byId = cabinets.ToDictionary(c => c.Id);
        Dictionary<Guid, bool?> loggedOn = await LatestUserLoggedOnAsync(cabinetIds, ct);
        IReadOnlyDictionary<string, string> parameters = DeserialiseParameters(batch.ParametersJson);

        batch.Status = BatchActionStatus.Approved;
        batch.ApprovedByUserId = actor.UserId;
        batch.ApprovedUtc = nowUtc;

        var expanded = 0;
        var skipped = 0;

        foreach (BatchActionTarget target in batch.Targets)
        {
            string? skip = EvaluateBatchTarget(entry, target.CabinetId, byId, loggedOn, nowUtc);

            if (skip is not null)
            {
                // Skips are reported, never proceeded past and never hidden. A
                // batch that half-runs must say which half.
                target.SkippedReason = skip;
                skipped++;

                _audit.Enqueue(new AuditRecord
                {
                    Event = AuditEvent.BatchTargetSkipped,
                    Action = entry.Action,
                    EventKind = AuditEventKind.Observed,
                    Result = AuditResult.Denied,
                    ActorType = ActorType.User,
                    ActorId = actor.UserId.ToString(),
                    ActorDisplayName = actor.Username,
                    CabinetId = target.CabinetId,
                    CabinetHostname = byId.GetValueOrDefault(target.CabinetId)?.Hostname,
                    Reason = skip,
                    BatchId = batch.Id,
                    Details = new { BatchId = batch.Id, target.CabinetId },
                });

                continue;
            }

            var action = new ActionRequest
            {
                Action = entry.Action,
                CabinetId = target.CabinetId,
                BatchId = batch.Id,
                RequestedByUserId = batch.RequestedByUserId,
                RequestedUtc = batch.RequestedUtc,
                ParametersJson = batch.ParametersJson,
                Reason = batch.Reason,
                TicketReference = batch.TicketReference,
                Status = ActionRequestStatus.Approved,
                ApprovedByUserId = actor.UserId,
                ApprovedUtc = nowUtc,
                ExpiresUtc = nowUtc.AddMinutes(_options.ApprovalExpiryMinutes),
            };

            _db.ActionRequests.Add(action);
            target.ActionRequestId = action.Id;
            expanded++;

            // Every cabinet gets its own audit row. A batch is legible only if
            // each cabinet's outcome can be read on its own.
            _audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.ApproveAction,
                Action = entry.Action,
                EventKind = AuditEventKind.Caused,
                Result = AuditResult.Success,
                ActorType = ActorType.User,
                ActorId = actor.UserId.ToString(),
                ActorDisplayName = actor.Username,
                CabinetId = target.CabinetId,
                CabinetHostname = byId.GetValueOrDefault(target.CabinetId)?.Hostname,
                Reason = batch.Reason,
                TicketReference = Clean(request.TicketReference) ?? batch.TicketReference,
                ApprovedByUserId = actor.UserId,
                BatchId = batch.Id,
                Details = new
                {
                    ActionRequestId = action.Id,
                    BatchId = batch.Id,
                    Action = entry.Action.ToString(),
                    Parameters = parameters,
                    action.ExpiresUtc,
                },
            });
        }

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.ApproveBatchAction,
            Action = entry.Action,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Reason = Clean(request.Note) ?? batch.Reason,
            TicketReference = Clean(request.TicketReference) ?? batch.TicketReference,
            ApprovedByUserId = actor.UserId,
            BatchId = batch.Id,
            Details = new
            {
                BatchId = batch.Id,
                Action = entry.Action.ToString(),
                batch.TargetCount,
                Expanded = expanded,
                Skipped = skipped,
                ApproverRole = actor.Role.ToString(),
            },
        });

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();

            return await DeniedBatchAsync(
                AuditEvent.ApproveBatchAction, actor,
                "Batch approval lost a race with another approver.",
                OperationResult<BatchActionRequest>.Conflict(
                    "This batch was already decided by another approver. Reload it to see the current state."),
                ct);
        }

        return OperationResult<BatchActionRequest>.Ok(batch);
    }

    /// <inheritdoc />
    public async Task<OperationResult<BatchActionRequest>> DenyBatchAsync(
        CurrentUser actor, Guid batchId, DenyActionRequest request, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        BatchActionRequest? batch = await _db.BatchActionRequests
            .Include(x => x.Targets)
            .FirstOrDefaultAsync(x => x.Id == batchId, ct);

        if (batch is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.DenyBatchAction, "Batch not found.", null, new { BatchId = batchId }, null, ct);
            return OperationResult<BatchActionRequest>.NotFound("Batch not found.");
        }

        if (!ActionCatalog.TryGet(batch.Action, out ActionCatalogEntry entry))
        {
            return await DeniedBatchAsync(
                AuditEvent.DenyBatchAction, actor, "Stored action is no longer in the catalog.",
                OperationResult<BatchActionRequest>.Conflict("This action is no longer supported."), ct);
        }

        if (batch.Status != BatchActionStatus.PendingApproval)
        {
            return await DeniedBatchAsync(
                AuditEvent.DenyBatchAction, actor,
                $"Batch is {batch.Status} and is not awaiting approval.",
                OperationResult<BatchActionRequest>.Conflict(
                    $"This batch is {batch.Status} and cannot be denied."), ct);
        }

        if (actor.Role < RequiredBatchApproverRole(entry, batch.TargetCount))
        {
            return await DeniedBatchAsync(
                AuditEvent.DenyBatchAction, actor,
                $"Deciding a batch of {batch.TargetCount} {entry.Action} is above the caller's role.",
                OperationResult<BatchActionRequest>.Forbidden(
                    "Deciding a batch of this size is above your role."), ct);
        }

        batch.Status = BatchActionStatus.Denied;
        batch.DenialReason = request.Reason.Trim();
        batch.ApprovedByUserId = null;

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.DenyBatchAction,
            Action = entry.Action,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Reason = batch.DenialReason,
            TicketReference = Clean(request.TicketReference) ?? batch.TicketReference,
            BatchId = batch.Id,
            Details = new
            {
                BatchId = batch.Id,
                Action = entry.Action.ToString(),
                batch.TargetCount,
                batch.RequestedByUserId,
            },
        });

        _ = nowUtc;

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();

            return await DeniedBatchAsync(
                AuditEvent.DenyBatchAction, actor,
                "Batch refusal lost a race with another approver.",
                OperationResult<BatchActionRequest>.Conflict(
                    "This batch was already decided by another approver."), ct);
        }

        return OperationResult<BatchActionRequest>.Ok(batch);
    }

    /// <summary>
    /// The role needed to approve a batch of this size, which is never lower
    /// than the action's own minimum.
    /// </summary>
    private static Role RequiredBatchApproverRole(ActionCatalogEntry entry, int targetCount)
    {
        if (targetCount >= entry.BatchSupervisorOnlyThreshold ||
            targetCount >= entry.BatchSupervisorThreshold)
        {
            return Role.Supervisor;
        }

        return entry.MinimumRole;
    }

    /// <summary>
    /// Whether one cabinet in a batch should be skipped, and why.
    /// </summary>
    /// <remarks>
    /// A batched reboot across a site is the most dangerous thing this tool
    /// does, so each cabinet is judged on its own state at approval time:
    /// somebody signed in, an unreadable logged-on flag, or a closed
    /// maintenance window in <em>that cabinet's</em> zone each take it out of
    /// the batch rather than proceeding.
    /// </remarks>
    private string? EvaluateBatchTarget(
        ActionCatalogEntry entry,
        Guid cabinetId,
        IReadOnlyDictionary<Guid, Cabinet> cabinets,
        IReadOnlyDictionary<Guid, bool?> loggedOn,
        DateTimeOffset nowUtc)
    {
        if (!cabinets.TryGetValue(cabinetId, out Cabinet? cabinet))
        {
            return "Cabinet no longer exists.";
        }

        if (!cabinet.IsActive)
        {
            return "Cabinet is not active.";
        }

        if (entry.BlockedIfUserLoggedOn)
        {
            bool? state = loggedOn.GetValueOrDefault(cabinetId);

            if (state is not false)
            {
                return state is null
                    ? "Skipped: the cabinet's logged-on state is unknown, which is treated as occupied."
                    : "Skipped: a user is logged on at the cabinet.";
            }
        }

        if (entry.MaintenanceWindowOnly && !_clock.IsInMaintenanceWindow(cabinet, nowUtc))
        {
            return _clock.ResolveZone(cabinet) is null
                ? "Skipped: the cabinet has not reported a resolvable time zone, so its maintenance " +
                  "window cannot be evaluated."
                : "Skipped: it is outside this cabinet's local maintenance window.";
        }

        return null;
    }

    /// <summary>
    /// Everything a single-cabinet request needs checked before it is written.
    /// </summary>
    private async Task<OperationResult<PreparedAction>> PrepareAsync(
        CurrentUser actor,
        ActionCatalogEntry entry,
        Cabinet cabinet,
        IReadOnlyDictionary<string, string> suppliedParameters,
        DateTimeOffset nowUtc,
        bool overrideRequested,
        string? overrideReason,
        AuditEvent auditEvent,
        CancellationToken ct)
    {
        // ---------------------------------------------------------------
        // Hardware actuation. Refused first, before the cabinet's state, the
        // caller's role, their grants or their parameters are considered — so
        // that there is no ordering of those checks under which one of these
        // could succeed. No agent has an executor for them either, which is the
        // second, independent reason nothing happens; this one is the reason
        // nothing is ever dispatched.
        // ---------------------------------------------------------------
        if (entry.IsReservedHardwareActuation)
        {
            await _audit.WriteAsync(new AuditRecord
            {
                Event = AuditEvent.HardwareActuationRefused,
                Action = entry.Action,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Denied,
                ActorType = ActorType.User,
                ActorId = actor.UserId.ToString(),
                ActorDisplayName = actor.Username,
                CabinetId = cabinet.Id,
                CabinetHostname = cabinet.Hostname,
                Reason = $"{entry.Action} is a reserved hardware-actuation action and is always refused.",
                Details = new
                {
                    Action = entry.Action.ToString(),
                    ActorRole = actor.Role.ToString(),
                    // Recorded either way. "Did the grant make a difference?"
                    // is the question a reviewer will have, and the answer has
                    // to be visible rather than inferred.
                    ActorHoldsHardwareActuationGrant = actor.HasHardwareActuation,
                },
            }, ct);

            return OperationResult<PreparedAction>.Forbidden(
                $"{entry.DisplayName} actuates cabinet hardware, which this platform does not do. " +
                "No role and no grant permits it, and no agent has an implementation of it. " +
                "The refusal has been recorded.");
        }

        if (!cabinet.IsActive)
        {
            return await DeniedAsync(
                auditEvent, actor, cabinet, "Cabinet is not active.",
                OperationResult<PreparedAction>.Conflict("Cabinet is not active."), ct);
        }

        // The caller's role comes from the signed token, never from the body.
        if (actor.Role < entry.MinimumRole)
        {
            return await DeniedAsync(
                auditEvent, actor, cabinet,
                $"{entry.Action} requires {entry.MinimumRole}; caller is {actor.Role}.",
                OperationResult<PreparedAction>.Forbidden(
                    $"{entry.DisplayName} requires the {entry.MinimumRole} role."), ct);
        }

        OperationResult<IReadOnlyDictionary<string, string>> parameters =
            _parameterValidator.Validate(entry, suppliedParameters, nowUtc, cabinet, _clock);

        if (!parameters.Succeeded)
        {
            return await DeniedAsync(
                auditEvent, actor, cabinet,
                parameters.Reason ?? "Parameter validation failed.",
                OperationResult<PreparedAction>.Invalid(parameters.Reason!), ct);
        }

        var mutable = new Dictionary<string, string>(parameters.Value!, StringComparer.OrdinalIgnoreCase);

        // The rep named a view. The server reads it from the database and
        // attaches its fields, so what reaches the agent is a Supervisor's
        // definition rather than anything a caller composed. A request that
        // arrived already carrying a definition was refused by the validator.
        if (entry.Action == ActionName.RunEventLogView)
        {
            OperationResult<PreparedAction> expanded =
                await ExpandEventLogViewAsync(actor, cabinet, mutable, auditEvent, ct);

            if (!expanded.Succeeded)
            {
                return expanded;
            }
        }

        Guid? targetCabinetId = null;
        string? targetHostname = null;
        var crossSite = false;

        if (entry.TargetsAnotherCabinet)
        {
            OperationResult<ResolvedTarget> target =
                await ResolveTargetAsync(actor, entry, cabinet, mutable, ct);

            if (!target.Succeeded)
            {
                return Propagate<ResolvedTarget, PreparedAction>(target);
            }

            targetCabinetId = target.Value!.Cabinet.Id;
            targetHostname = target.Value.Cabinet.Hostname;
            crossSite = target.Value.IsCrossSite;

            // The server resolves the address. This is the only place it is
            // set, and a request that arrived carrying one was already refused.
            mutable[ActionCatalog.ResolvedTargetAddressKey] = target.Value.Address;
        }

        // Safety gates. Only a Supervisor may pass them, and only with a reason
        // that goes into the record alongside the override itself.
        if (overrideRequested)
        {
            if (actor.Role < Role.Supervisor)
            {
                return await DeniedAsync(
                    auditEvent, actor, cabinet,
                    "Safety-check override attempted by a non-Supervisor.",
                    OperationResult<PreparedAction>.Forbidden(
                        "Only a Supervisor may override safety checks."), ct);
            }

            if (string.IsNullOrWhiteSpace(overrideReason))
            {
                return await DeniedAsync(
                    auditEvent, actor, cabinet,
                    "Safety-check override attempted without a reason.",
                    OperationResult<PreparedAction>.Invalid(
                        "An override reason is required when overriding safety checks."), ct);
            }
        }

        if (entry.MaintenanceWindowOnly && !overrideRequested &&
            !_clock.IsInMaintenanceWindow(cabinet, nowUtc))
        {
            DateTimeOffset? local = _clock.ToCabinetLocal(cabinet, nowUtc);

            return await DeniedAsync(
                auditEvent, actor, cabinet,
                local is null
                    ? $"{entry.Action} is maintenance-window only and the cabinet's zone is unresolvable."
                    : $"{entry.Action} is maintenance-window only; it is {local:HH:mm} at the cabinet.",
                OperationResult<PreparedAction>.Conflict(
                    local is null
                        ? $"{entry.DisplayName} may only run inside the cabinet's local maintenance " +
                          "window, and this cabinet has not reported a time zone this server can resolve."
                        : $"{entry.DisplayName} may only run between " +
                          $"{_options.MaintenanceWindowStartHourLocal:00}:00 and " +
                          $"{_options.MaintenanceWindowEndHourLocal:00}:00 at the cabinet, where it is " +
                          $"now {local:HH:mm}."), ct);
        }

        if (entry.BlockedIfUserLoggedOn && !overrideRequested)
        {
            Dictionary<Guid, bool?> states = await LatestUserLoggedOnAsync(new[] { cabinet.Id }, ct);
            bool? loggedOn = states.GetValueOrDefault(cabinet.Id);

            // Unknown is treated as blocked. A cabinet that has not reported
            // recently might have a clinician standing at it mid-dispense, and
            // "we could not tell" is never "nobody is there".
            if (loggedOn is not false)
            {
                return await DeniedAsync(
                    auditEvent, actor, cabinet,
                    loggedOn is null
                        ? $"{entry.Action} blocked: no recent heartbeat, logged-on state unknown."
                        : $"{entry.Action} blocked: a user is logged on.",
                    OperationResult<PreparedAction>.Conflict(
                        loggedOn is null
                            ? $"{entry.DisplayName} is blocked because the cabinet's logged-on state is unknown."
                            : $"{entry.DisplayName} is blocked while a user is logged on."), ct);
            }
        }

        return OperationResult<PreparedAction>.Ok(
            new PreparedAction(mutable, targetCabinetId, targetHostname, crossSite, overrideRequested));
    }

    /// <summary>
    /// Resolves the cabinet a diagnostic probe names, and decides whether this
    /// source may probe it at all.
    /// </summary>
    /// <remarks>
    /// The client boundary is absolute: a rep must never be able to probe one
    /// client's network from another client's cabinet, and an attempt to is
    /// refused and audited distinctly. Crossing sites within one client is
    /// allowed but must be asked for explicitly, because the default and the
    /// useful case is a satellite testing its own site's sync cabinet.
    /// </remarks>
    /// <summary>
    /// Reads the named view and attaches its fields to the request.
    /// </summary>
    /// <remarks>
    /// The definition is serialised into a single validated parameter rather
    /// than spread across a dozen keys, because it is one indivisible thing: a
    /// view with its sources but not its event ids is a different filter, and
    /// a partially-applied one would silently return the firehose the view
    /// exists to replace.
    /// </remarks>
    private async Task<OperationResult<PreparedAction>> ExpandEventLogViewAsync(
        CurrentUser actor,
        Cabinet cabinet,
        Dictionary<string, string> parameters,
        AuditEvent auditEvent,
        CancellationToken ct)
    {
        Guid viewId = Guid.Parse(parameters[ActionParameterKeys.EventLogViewId]);

        int? windowOverride =
            parameters.TryGetValue(ActionParameterKeys.HoursOfHistory, out string? rawWindow) &&
            int.TryParse(rawWindow, NumberStyles.Integer, CultureInfo.InvariantCulture, out int hours)
                ? hours
                : null;

        OperationResult<EventLogViewDefinition> definition =
            await _eventLogViews.ExpandAsync(viewId, windowOverride, ct);

        if (!definition.Succeeded)
        {
            return await DeniedAsync(
                auditEvent, actor, cabinet, definition.Reason!,
                Propagate<EventLogViewDefinition, PreparedAction>(definition), ct);
        }

        parameters[ActionParameterKeys.EventLogViewDefinition] =
            JsonSerializer.Serialize(definition.Value!, ContractJson.Default);

        // The window the agent will actually use, echoed back so the stored
        // request says what was run rather than what was asked for.
        parameters[ActionParameterKeys.HoursOfHistory] =
            definition.Value!.WindowHours.ToString(CultureInfo.InvariantCulture);

        return OperationResult<PreparedAction>.Ok(
            new PreparedAction(parameters, null, null, false, false));
    }

    private async Task<OperationResult<ResolvedTarget>> ResolveTargetAsync(
        CurrentUser actor,
        ActionCatalogEntry entry,
        Cabinet source,
        IReadOnlyDictionary<string, string> parameters,
        CancellationToken ct)
    {
        Guid targetId = Guid.Parse(parameters[ActionCatalog.TargetCabinetIdKey]);

        if (targetId == source.Id)
        {
            return OperationResult<ResolvedTarget>.Invalid(
                "A cabinet cannot probe itself. Pick a different target.");
        }

        Cabinet? target = await _db.Cabinets
            .Include(c => c.Site)
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == targetId, ct);

        if (target?.Site is null || source.Site is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.CabinetLinkTest, "Probe target not found.", source.Id,
                new { TargetCabinetId = targetId }, entry.Action, ct);

            return OperationResult<ResolvedTarget>.NotFound("Target cabinet not found.");
        }

        if (target.Site.ClientId != source.Site.ClientId)
        {
            // Refused outright and audited under its own event, because this is
            // the attempt a reviewer will want to find: one client's network
            // being probed from another client's equipment.
            await _audit.WriteAsync(new AuditRecord
            {
                Event = AuditEvent.CrossClientCabinetLinkTestRejected,
                Action = entry.Action,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Denied,
                ActorType = ActorType.User,
                ActorId = actor.UserId.ToString(),
                ActorDisplayName = actor.Username,
                CabinetId = source.Id,
                CabinetHostname = source.Hostname,
                TargetCabinetId = target.Id,
                TargetCabinetHostname = target.Hostname,
                Reason = "Probe target belongs to a different client.",
                Details = new
                {
                    SourceClientId = source.Site.ClientId,
                    TargetClientId = target.Site.ClientId,
                },
            }, ct);

            // The wording does not confirm that the target exists: a rep who
            // guessed an id learns nothing about another client's fleet.
            return OperationResult<ResolvedTarget>.NotFound("Target cabinet not found.");
        }

        bool crossSite = target.SiteId != source.SiteId;

        if (crossSite)
        {
            bool allowed = parameters.TryGetValue(ActionCatalog.AllowCrossSiteKey, out string? raw) &&
                           bool.TryParse(raw, out bool parsed) && parsed;

            if (!allowed)
            {
                await _audit.WriteDenialAsync(
                    AuditEvent.CrossSiteCabinetLinkTest,
                    "Cross-site probe attempted without an explicit request.",
                    source.Id,
                    new { TargetCabinetId = target.Id, TargetSiteId = target.SiteId },
                    entry.Action,
                    ct);

                return OperationResult<ResolvedTarget>.Invalid(
                    "That cabinet is at a different site. Cross-site probing is possible but has to be " +
                    "asked for explicitly, because it tests a path the cabinets do not normally use.");
            }
        }

        if (!target.IsActive)
        {
            return OperationResult<ResolvedTarget>.Conflict("Target cabinet is not active.");
        }

        if (string.IsNullOrWhiteSpace(target.LastKnownIpAddress))
        {
            return OperationResult<ResolvedTarget>.Conflict(
                "The target cabinet has not reported a local address, so there is nothing to probe. " +
                "It needs a full check-in first.");
        }

        return OperationResult<ResolvedTarget>.Ok(
            new ResolvedTarget(target, target.LastKnownIpAddress, crossSite));
    }

    /// <summary>
    /// Reads the logged-on flag from the projected column of each cabinet's
    /// newest heartbeat. Never deserialises a stored payload to answer this.
    /// </summary>
    private async Task<Dictionary<Guid, bool?>> LatestUserLoggedOnAsync(
        IReadOnlyCollection<Guid> cabinetIds, CancellationToken ct)
    {
        var rows = await _db.Heartbeats
            .AsNoTracking()
            .Where(h => cabinetIds.Contains(h.CabinetId))
            .GroupBy(h => h.CabinetId)
            .Select(g => new
            {
                CabinetId = g.Key,
                AnyUserLoggedOn = g
                    .OrderByDescending(h => h.ReceivedUtc)
                    .Select(h => h.AnyUserLoggedOn)
                    .FirstOrDefault(),
                Latest = g.Max(h => h.ReceivedUtc),
            })
            .ToListAsync(ct);

        var result = new Dictionary<Guid, bool?>();

        foreach (Guid id in cabinetIds)
        {
            // A cabinet with no heartbeat at all is unknown, not unoccupied.
            result[id] = rows.FirstOrDefault(r => r.CabinetId == id)?.AnyUserLoggedOn;
        }

        return result;
    }

    private static IReadOnlyDictionary<string, string> DeserialiseParameters(string json)
    {
        try
        {
            Dictionary<string, string>? read =
                JsonSerializer.Deserialize<Dictionary<string, string>>(json, ContractJson.Default);

            // Rebuilt case-insensitively. Stored parameter names are the
            // catalog's, but a dictionary that compares ordinally turns any
            // future difference in case into an action the agent silently
            // declines, for a reason visible from neither side.
            return read is null
                ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, string>(read, StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static OperationResult<TOut> Propagate<TIn, TOut>(OperationResult<TIn> source) =>
        source.Failure switch
        {
            OperationFailure.NotFound => OperationResult<TOut>.NotFound(source.Reason!),
            OperationFailure.Forbidden => OperationResult<TOut>.Forbidden(source.Reason!),
            OperationFailure.Conflict => OperationResult<TOut>.Conflict(source.Reason!),
            _ => OperationResult<TOut>.Invalid(source.Reason ?? "The request could not be completed."),
        };

    private async Task<OperationResult<T>> DeniedAsync<T>(
        AuditEvent auditEvent,
        CurrentUser actor,
        Cabinet? cabinet,
        string reason,
        OperationResult<T> result,
        CancellationToken ct)
    {
        await _audit.WriteAsync(new AuditRecord
        {
            Event = auditEvent,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Denied,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = cabinet?.Id,
            CabinetHostname = cabinet?.Hostname,
            Reason = reason,
        }, ct);

        return result;
    }

    private Task<OperationResult<BatchActionRequest>> DeniedBatchAsync(
        AuditEvent auditEvent,
        CurrentUser actor,
        string reason,
        OperationResult<BatchActionRequest> result,
        CancellationToken ct) =>
        DeniedAsync(auditEvent, actor, null, reason, result, ct);

    private sealed record PreparedAction(
        IReadOnlyDictionary<string, string> Parameters,
        Guid? TargetCabinetId,
        string? TargetCabinetHostname,
        bool IsCrossSiteTarget,
        bool OverrideApplied);

    private sealed record ResolvedTarget(Cabinet Cabinet, string Address, bool IsCrossSite);
}
