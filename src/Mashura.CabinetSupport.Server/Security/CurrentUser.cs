using System.Security.Claims;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Server.Security;

/// <summary>
/// The authenticated caller, resolved from the signed token and nothing else.
///
/// Controllers use this instead of reading ids or roles out of request bodies.
/// A client that sends its own user id, role or cabinet id in a payload is
/// ignored — the server is the only authority on who the caller is.
/// </summary>
public sealed record CurrentUser(Guid UserId, string Username, UserRole Role, bool HasElevatedSql)
{
    public bool IsAtLeast(UserRole minimum) => Role >= minimum;
}

public static class ClaimsPrincipalExtensions
{
    /// <summary>
    /// Returns null when the principal is not a fully-formed support user —
    /// an agent principal, or a token missing claims, resolves to nothing
    /// rather than to a partially-populated user.
    /// </summary>
    public static CurrentUser? GetCurrentUser(this ClaimsPrincipal principal)
    {
        if (principal.Identity?.IsAuthenticated != true)
        {
            return null;
        }

        string? rawId = principal.FindFirst(SupportClaims.UserId)?.Value;
        string? rawRole = principal.FindFirst(SupportClaims.Role)?.Value;

        if (!Guid.TryParse(rawId, out Guid userId) ||
            !Enum.TryParse(rawRole, ignoreCase: false, out UserRole role))
        {
            return null;
        }

        string username = principal.FindFirst(ClaimTypes.Name)?.Value ?? string.Empty;
        bool elevated = string.Equals(
            principal.FindFirst(SupportClaims.ElevatedSql)?.Value, "true", StringComparison.OrdinalIgnoreCase);

        return new CurrentUser(userId, username, role, elevated);
    }

    /// <summary>The machine id an authenticated agent presented, if any.</summary>
    public static string? GetAgentMachineId(this ClaimsPrincipal principal) =>
        principal.Identity?.IsAuthenticated == true
            ? principal.FindFirst(AgentAuthenticationHandler.MachineIdClaimType)?.Value
            : null;
}
