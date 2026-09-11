using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;

namespace CabinetPlatform.Server.Auditing;

/// <summary>
/// Catches denials that happen in the authorization middleware, before any
/// controller action runs.
///
/// Without this, the endpoints write their own audit records and the requests
/// that never reach an endpoint — the ones a policy refused — leave no trace
/// at all. Those are precisely the attempts a compliance reviewer will ask
/// about, so they are recorded here instead.
/// </summary>
public sealed class AuditingAuthorizationResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public async Task HandleAsync(
        RequestDelegate next,
        HttpContext context,
        AuthorizationPolicy policy,
        PolicyAuthorizationResult authorizeResult)
    {
        if (!authorizeResult.Succeeded)
        {
            // Resolved through the request scope: this handler is a singleton,
            // and the audit service and its DbContext are scoped.
            var audit = context.RequestServices.GetRequiredService<IAuditService>();

            CurrentUser? user = context.User.GetCurrentUser();
            string? machineId = context.User.GetAgentMachineId();

            (string actorType, string? actorId, string? actorName) = user is not null
                ? (ActorTypes.User, user.UserId.ToString(), user.Username)
                : machineId is not null
                    ? (ActorTypes.Agent, machineId, (string?)null)
                    : (ActorTypes.Anonymous, null, (string?)null);

            string reason = authorizeResult.Challenged
                ? "Not authenticated."
                : authorizeResult.Forbidden
                    ? "Authenticated but not permitted by policy."
                    : "Authorization failed.";

            try
            {
                await audit.WriteAsync(new AuditRecord
                {
                    Action = AuditActions.AuthorizationDenied,
                    EventKind = AuditEventKind.Observed,
                    Result = AuditResult.Denied,
                    ActorType = actorType,
                    ActorId = actorId,
                    ActorDisplayName = actorName,
                    Reason = reason,
                    Details = new
                    {
                        Path = context.Request.Path.Value,
                        Method = context.Request.Method,
                        Endpoint = context.GetEndpoint()?.DisplayName
                    }
                }, context.RequestAborted);
            }
            catch (Exception ex)
            {
                // The denial itself must still be returned to the caller even
                // if the audit write fails, but a failure to record a refused
                // request is a serious event in its own right — log it loudly.
                var logger = context.RequestServices
                    .GetRequiredService<ILogger<AuditingAuthorizationResultHandler>>();
                logger.LogError(ex,
                    "Failed to write audit record for an authorization denial on {Method} {Path}.",
                    context.Request.Method, context.Request.Path);
            }
        }

        await _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
