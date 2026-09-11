using System.Text.Json;
using Mashura.CabinetSupport.Contracts.Actions;
using Mashura.CabinetSupport.Contracts.Enums;
using Mashura.CabinetSupport.Server.Actions;
using Mashura.CabinetSupport.Server.Auditing;
using Mashura.CabinetSupport.Server.Configuration;
using Mashura.CabinetSupport.Server.Data;
using Mashura.CabinetSupport.Server.Domain;
using Mashura.CabinetSupport.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Mashura.CabinetSupport.Server.Services;

public interface IActionRequestService
{
    Task<OperationResult<ActionRequest>> CreateAsync(
        CurrentUser actor, CreateActionRequest request, CancellationToken ct);

    Task<OperationResult<ActionRequest>> ApproveAsync(
        CurrentUser actor, Guid actionId, ApproveActionRequest request, CancellationToken ct);

    Task<OperationResult<ActionRequest>> DenyAsync(
        CurrentUser actor, Guid actionId, DenyActionRequest request, CancellationToken ct);
}

/// <summary>
/// Everything that decides whether a catalogued action may run, and who may
/// let it run.
///
/// The rules that matter are enforced here rather than in a controller, so
/// that there is exactly one path to creating and approving an action and no
/// second, less careful one.
/// </summary>
public sealed class ActionRequestService : IActionRequestService
{
    private readonly SupportDbContext _db;
    private readonly IActionParameterValidator _parameterValidator;
    private readonly IAuditService _audit;
    private readonly ActionOptions _options;
    private readonly TimeProvider _timeProvider;

    public ActionRequestService(
        SupportDbContext db,
        IActionParameterValidator parameterValidator,
        IAuditService audit,
        IOptions<ActionOptions> options,
        TimeProvider timeProvider)
    {
        _db = db;
        _parameterValidator = parameterValidator;
        _audit = audit;
        _options = options.Value;
        _timeProvider = timeProvider;
    }

    public async Task<OperationResult<ActionRequest>> CreateAsync(
        CurrentUser actor, CreateActionRequest request, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        // An integer outside the enum can arrive in any JSON body, so the
        // catalogue lookup is the gate, not the deserialiser.
        if (!ActionCatalog.TryGet(request.Action, out ActionCatalogEntry entry))
        {
            return await DeniedAsync(
                AuditActions.RequestAction, actor, null,
                $"Action '{request.Action}' is not in the catalogue.",
                OperationResult<ActionRequest>.Invalid("Unknown action."), ct);
        }

        Cabinet? cabinet = await _db.Cabinets
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == request.CabinetId, ct);

        if (cabinet is null)
        {
            return await DeniedAsync(
                AuditActions.RequestAction, actor, null,
                "Cabinet not found.",
                OperationResult<ActionRequest>.NotFound("Cabinet not found."), ct);
        }

        if (!cabinet.IsActive)
        {
            return await DeniedAsync(
                AuditActions.RequestAction, actor, cabinet,
                "Cabinet is not active.",
                OperationResult<ActionRequest>.Conflict("Cabinet is not active."), ct);
        }

        // The caller's role comes from the signed token, never from the body.
        if (actor.Role < entry.MinimumRole)
        {
            return await DeniedAsync(
                AuditActions.RequestAction, actor, cabinet,
                $"{entry.Action} requires {entry.MinimumRole}; caller is {actor.Role}.",
                OperationResult<ActionRequest>.Forbidden(
                    $"{entry.DisplayName} requires the {entry.MinimumRole} role."), ct);
        }

        OperationResult<IReadOnlyDictionary<string, string>> parameters =
            _parameterValidator.Validate(entry, request.Parameters);

        if (!parameters.Succeeded)
        {
            return await DeniedAsync(
                AuditActions.RequestAction, actor, cabinet,
                parameters.Reason ?? "Parameter validation failed.",
                OperationResult<ActionRequest>.Invalid(parameters.Reason!), ct);
        }

        // Safety gates. Only a Supervisor may pass them, and only with a
        // reason that goes into the record alongside the override itself.
        bool overrideRequested = request.OverrideSafetyChecks;

        if (overrideRequested)
        {
            if (actor.Role < UserRole.Supervisor)
            {
                return await DeniedAsync(
                    AuditActions.RequestAction, actor, cabinet,
                    "Safety-check override attempted by a non-Supervisor.",
                    OperationResult<ActionRequest>.Forbidden(
                        "Only a Supervisor may override safety checks."), ct);
            }

            if (string.IsNullOrWhiteSpace(request.OverrideReason))
            {
                return await DeniedAsync(
                    AuditActions.RequestAction, actor, cabinet,
                    "Safety-check override attempted without a reason.",
                    OperationResult<ActionRequest>.Invalid(
                        "An override reason is required when overriding safety checks."), ct);
            }
        }

        if (entry.MaintenanceWindowOnly && !overrideRequested && !IsInMaintenanceWindow(nowUtc))
        {
            return await DeniedAsync(
                AuditActions.RequestAction, actor, cabinet,
                $"{entry.Action} is maintenance-window only; now is {nowUtc:HH:mm}Z.",
                OperationResult<ActionRequest>.Conflict(
                    $"{entry.DisplayName} may only run between " +
                    $"{_options.MaintenanceWindowStartHourUtc:00}:00Z and " +
                    $"{_options.MaintenanceWindowEndHourUtc:00}:00Z."), ct);
        }

        if (entry.BlockedIfUserLoggedOn && !overrideRequested)
        {
            bool? loggedOn = await LatestUserLoggedOnAsync(cabinet.Id, ct);

            // Unknown is treated as blocked. A cabinet that has not reported
            // recently might have a clinician standing at it mid-dispense.
            if (loggedOn is not false)
            {
                return await DeniedAsync(
                    AuditActions.RequestAction, actor, cabinet,
                    loggedOn is null
                        ? $"{entry.Action} blocked: no recent check-in, logged-on state unknown."
                        : $"{entry.Action} blocked: a user is logged on.",
                    OperationResult<ActionRequest>.Conflict(
                        loggedOn is null
                            ? $"{entry.DisplayName} is blocked because the cabinet's logged-on state is unknown."
                            : $"{entry.DisplayName} is blocked while a user is logged on."), ct);
            }
        }

        var action = new ActionRequest
        {
            Action = entry.Action,
            CabinetId = cabinet.Id,
            RequestedByUserId = actor.UserId,
            RequestedUtc = nowUtc,
            ParametersJson = JsonSerializer.Serialize(parameters.Value),
            Reason = request.Reason.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? null
                : request.TicketReference.Trim(),
            SafetyChecksOverridden = overrideRequested,
            OverrideReason = overrideRequested ? request.OverrideReason!.Trim() : null,
            Status = entry.RequiresApproval
                ? ActionRequestStatus.PendingApproval
                : ActionRequestStatus.Approved
        };

        if (!entry.RequiresApproval)
        {
            // No-approval actions are collectable straight away, but they
            // still expire: an uncollected action must not fire hours later.
            action.ExpiresUtc = nowUtc.AddMinutes(_options.UnapprovedActionExpiryMinutes);
        }

        _db.ActionRequests.Add(action);

        // Requesting an action is an intent to change a cabinet, so it is a
        // Caused event even before anything reaches the agent.
        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.RequestAction,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = cabinet.Id,
            CabinetHostname = cabinet.Hostname,
            Reason = action.Reason,
            TicketReference = action.TicketReference,
            Details = new
            {
                ActionRequestId = action.Id,
                Action = entry.Action.ToString(),
                RequiresApproval = entry.RequiresApproval,
                IsDisruptive = entry.IsDisruptive,
                Parameters = parameters.Value,
                SafetyChecksOverridden = overrideRequested,
                OverrideReason = action.OverrideReason,
                Status = action.Status.ToString()
            }
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult<ActionRequest>.Ok(action);
    }

    public async Task<OperationResult<ActionRequest>> ApproveAsync(
        CurrentUser actor, Guid actionId, ApproveActionRequest request, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        ActionRequest? action = await _db.ActionRequests
            .Include(a => a.Cabinet)
            .FirstOrDefaultAsync(a => a.Id == actionId, ct);

        if (action is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.ApproveAction, "Action request not found.", null,
                new { ActionRequestId = actionId }, ct);
            return OperationResult<ActionRequest>.NotFound("Action request not found.");
        }

        if (!ActionCatalog.TryGet(action.Action, out ActionCatalogEntry entry))
        {
            return await DeniedAsync(
                AuditActions.ApproveAction, actor, action.Cabinet,
                "Stored action is no longer in the catalogue.",
                OperationResult<ActionRequest>.Conflict(
                    "This action is no longer supported and cannot be approved."), ct);
        }

        // ---------------------------------------------------------------
        // The four-eyes rule. An explicit check, not an assumption that the
        // console hid the button: the person who asked for a disruptive action
        // on a controlled-substance cabinet must never be the person who
        // signs it off.
        // ---------------------------------------------------------------
        if (action.RequestedByUserId == actor.UserId)
        {
            return await DeniedAsync(
                AuditActions.ApproveAction, actor, action.Cabinet,
                "Approver is the requester; the four-eyes rule refuses self-approval.",
                OperationResult<ActionRequest>.Forbidden(
                    "You cannot approve an action you requested yourself."), ct);
        }

        if (actor.Role < entry.MinimumRole)
        {
            return await DeniedAsync(
                AuditActions.ApproveAction, actor, action.Cabinet,
                $"Approving {entry.Action} requires {entry.MinimumRole}; caller is {actor.Role}.",
                OperationResult<ActionRequest>.Forbidden(
                    $"Approving {entry.DisplayName} requires the {entry.MinimumRole} role."), ct);
        }

        if (action.Status != ActionRequestStatus.PendingApproval)
        {
            return await DeniedAsync(
                AuditActions.ApproveAction, actor, action.Cabinet,
                $"Action is {action.Status} and is not awaiting approval.",
                OperationResult<ActionRequest>.Conflict(
                    $"This action is {action.Status} and cannot be approved."), ct);
        }

        if (action.Cabinet is { IsActive: false })
        {
            return await DeniedAsync(
                AuditActions.ApproveAction, actor, action.Cabinet,
                "Cabinet is no longer active.",
                OperationResult<ActionRequest>.Conflict("Cabinet is not active."), ct);
        }

        action.Status = ActionRequestStatus.Approved;
        action.ApprovedByUserId = actor.UserId;
        action.ApprovedUtc = nowUtc;
        action.ExpiresUtc = nowUtc.AddMinutes(_options.ApprovalExpiryMinutes);

        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.ApproveAction,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = action.CabinetId,
            CabinetHostname = action.Cabinet?.Hostname,
            Reason = request.Note?.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? action.TicketReference
                : request.TicketReference.Trim(),
            ApprovedByUserId = actor.UserId,
            Details = new
            {
                ActionRequestId = action.Id,
                Action = action.Action.ToString(),
                RequestedByUserId = action.RequestedByUserId,
                ExpiresUtc = action.ExpiresUtc
            }
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult<ActionRequest>.Ok(action);
    }

    public async Task<OperationResult<ActionRequest>> DenyAsync(
        CurrentUser actor, Guid actionId, DenyActionRequest request, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        ActionRequest? action = await _db.ActionRequests
            .Include(a => a.Cabinet)
            .FirstOrDefaultAsync(a => a.Id == actionId, ct);

        if (action is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.DenyAction, "Action request not found.", null,
                new { ActionRequestId = actionId }, ct);
            return OperationResult<ActionRequest>.NotFound("Action request not found.");
        }

        if (!ActionCatalog.TryGet(action.Action, out ActionCatalogEntry entry))
        {
            return await DeniedAsync(
                AuditActions.DenyAction, actor, action.Cabinet,
                "Stored action is no longer in the catalogue.",
                OperationResult<ActionRequest>.Conflict("This action is no longer supported."), ct);
        }

        if (actor.Role < entry.MinimumRole)
        {
            return await DeniedAsync(
                AuditActions.DenyAction, actor, action.Cabinet,
                $"Denying {entry.Action} requires {entry.MinimumRole}; caller is {actor.Role}.",
                OperationResult<ActionRequest>.Forbidden(
                    $"Denying {entry.DisplayName} requires the {entry.MinimumRole} role."), ct);
        }

        if (action.Status != ActionRequestStatus.PendingApproval)
        {
            return await DeniedAsync(
                AuditActions.DenyAction, actor, action.Cabinet,
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
            Action = AuditActions.DenyAction,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = action.CabinetId,
            CabinetHostname = action.Cabinet?.Hostname,
            Reason = request.Reason.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? action.TicketReference
                : request.TicketReference.Trim(),
            Details = new
            {
                ActionRequestId = action.Id,
                Action = action.Action.ToString(),
                RequestedByUserId = action.RequestedByUserId
            }
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult<ActionRequest>.Ok(action);
    }

    private bool IsInMaintenanceWindow(DateTime nowUtc)
    {
        int hour = nowUtc.Hour;
        int start = _options.MaintenanceWindowStartHourUtc;
        int end = _options.MaintenanceWindowEndHourUtc;

        // A window configured to wrap past midnight (22:00–04:00) is the
        // normal case for clinics, so handle it rather than assuming start<end.
        return start <= end
            ? hour >= start && hour < end
            : hour >= start || hour < end;
    }

    /// <summary>
    /// Reads the logged-on flag from the projected column of the newest
    /// check-in. Never deserialises the stored payload to answer this.
    /// </summary>
    private async Task<bool?> LatestUserLoggedOnAsync(Guid cabinetId, CancellationToken ct)
    {
        var latest = await _db.CheckIns
            .AsNoTracking()
            .Where(c => c.CabinetId == cabinetId)
            .OrderByDescending(c => c.ReceivedUtc)
            .Select(c => new { c.AnyUserLoggedOn })
            .FirstOrDefaultAsync(ct);

        return latest?.AnyUserLoggedOn;
    }

    private async Task<OperationResult<ActionRequest>> DeniedAsync(
        string auditAction,
        CurrentUser actor,
        Cabinet? cabinet,
        string reason,
        OperationResult<ActionRequest> result,
        CancellationToken ct)
    {
        await _audit.WriteAsync(new AuditRecord
        {
            Action = auditAction,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Denied,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            CabinetId = cabinet?.Id,
            CabinetHostname = cabinet?.Hostname,
            Reason = reason
        }, ct);

        return result;
    }
}
