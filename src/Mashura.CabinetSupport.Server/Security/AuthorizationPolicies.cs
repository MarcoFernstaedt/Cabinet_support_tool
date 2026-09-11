using Mashura.CabinetSupport.Contracts.Enums;
using Microsoft.AspNetCore.Authorization;

namespace Mashura.CabinetSupport.Server.Security;

/// <summary>
/// Claim types this server issues and trusts. The values in these claims come
/// from the user row at login and are re-read from the signed token on every
/// request — never from a request body, a header, or a query string.
/// </summary>
public static class SupportClaims
{
    public const string UserId = "mashura:uid";
    public const string Role = "mashura:role";
    public const string ElevatedSql = "mashura:elevated_sql";
    public const string MustChangePassword = "mashura:must_change_password";
    public const string SessionId = "mashura:sid";
}

public static class AuthorizationPolicies
{
    public const string RequireTier1 = nameof(RequireTier1);
    public const string RequireTier2 = nameof(RequireTier2);
    public const string RequireSupervisor = nameof(RequireSupervisor);
    public const string RequireElevatedSql = nameof(RequireElevatedSql);

    /// <summary>
    /// Applied to the agent surface, which authenticates by shared secret in
    /// middleware rather than by bearer token. It is still an explicit policy:
    /// the point of the default-deny fallback is that nothing is unlabelled.
    /// </summary>
    public const string RequireAgent = nameof(RequireAgent);

    /// <summary>
    /// The two endpoints a user must reach while holding a
    /// must-change-password token: reading their own identity, and changing
    /// their password. Authenticated, but exempt from that gate.
    /// </summary>
    public const string RequireAuthenticatedUser = nameof(RequireAuthenticatedUser);

    public static readonly IReadOnlyList<string> All = new[]
    {
        RequireTier1,
        RequireTier2,
        RequireSupervisor,
        RequireElevatedSql,
        RequireAgent,
        RequireAuthenticatedUser
    };
}

/// <summary>Requires a resolved role at or above <see cref="MinimumRole"/>.</summary>
public sealed class MinimumRoleRequirement : IAuthorizationRequirement
{
    public MinimumRoleRequirement(UserRole minimumRole) => MinimumRole = minimumRole;

    public UserRole MinimumRole { get; }
}

/// <summary>
/// Blocks a principal whose password is flagged as needing a change from doing
/// anything except changing it. A stale must-change session is otherwise a
/// perfectly usable session, which defeats the point of the flag.
/// </summary>
public sealed class PasswordNotExpiredRequirement : IAuthorizationRequirement;

public sealed class MinimumRoleHandler : AuthorizationHandler<MinimumRoleRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        MinimumRoleRequirement requirement)
    {
        string? raw = context.User.FindFirst(SupportClaims.Role)?.Value;

        // An unparseable or absent role claim is a denial, never a default.
        if (Enum.TryParse(raw, ignoreCase: false, out UserRole role) &&
            role >= requirement.MinimumRole)
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

public sealed class PasswordNotExpiredHandler : AuthorizationHandler<PasswordNotExpiredRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        PasswordNotExpiredRequirement requirement)
    {
        string? raw = context.User.FindFirst(SupportClaims.MustChangePassword)?.Value;

        if (!string.Equals(raw, "true", StringComparison.OrdinalIgnoreCase))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

/// <summary>Requires the elevated-SQL grant, which is separate from role.</summary>
public sealed class ElevatedSqlRequirement : IAuthorizationRequirement;

public sealed class ElevatedSqlHandler : AuthorizationHandler<ElevatedSqlRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        ElevatedSqlRequirement requirement)
    {
        string? raw = context.User.FindFirst(SupportClaims.ElevatedSql)?.Value;

        if (string.Equals(raw, "true", StringComparison.OrdinalIgnoreCase))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}
