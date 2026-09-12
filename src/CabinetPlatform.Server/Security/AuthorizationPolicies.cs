using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.AspNetCore.Authorization;

namespace CabinetPlatform.Server.Security;

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
    public const string HardwareActuation = "mashura:hardware_actuation";
    public const string MustChangePassword = "mashura:must_change_password";
    public const string SessionId = "mashura:sid";
}

/// <summary>
/// The named policies every endpoint in this server carries.
/// </summary>
/// <remarks>
/// <para>
/// Roles are labels in this build. Reps reach any cabinet at any time, so
/// <see cref="RequireSupportUser"/> guards every cabinet and Windows operation
/// and resolves to "any authenticated rep, Tier 1 or above". The role
/// comparison still runs on every one of those requests; only the threshold is
/// permissive, and tightening it later is a change to this file rather than to
/// thirty controllers.
/// </para>
/// <para>
/// <see cref="RequireSupervisor"/> is not a label. It guards exactly five
/// things, which are the ones where a rep's mistake is not recoverable by
/// another rep: creating and amending users, admitting and refusing cabinets,
/// setting cabinet roles and site topology, editing the shared event log views,
/// and granting or withdrawing the reserved hardware-actuation permission.
/// </para>
/// </remarks>
public static class AuthorizationPolicies
{
    /// <summary>
    /// Any authenticated support user. The policy every cabinet and Windows
    /// operation carries.
    /// </summary>
    public const string RequireSupportUser = nameof(RequireSupportUser);

    /// <summary>
    /// Retained name for <see cref="RequireSupportUser"/>.
    /// </summary>
    /// <remarks>
    /// Kept because it is spelled across a large number of endpoints and
    /// changing every one of them at once would make the diff that flattened
    /// the roles unreadable. It is the same policy object; there is no second
    /// set of rules behind it.
    /// </remarks>
    public const string RequireTier1 = RequireSupportUser;

    /// <summary>
    /// Formerly a second tier. Now the same policy as
    /// <see cref="RequireSupportUser"/>.
    /// </summary>
    /// <remarks>
    /// Deliberately not deleted. Every endpoint that used to demand Tier 2 is a
    /// place somebody once judged the work more consequential, and that
    /// judgement is worth keeping legible for whoever tightens this later. What
    /// is <em>not</em> kept is a second behaviour: this constant and
    /// <see cref="RequireSupportUser"/> are the same string and resolve to the
    /// same policy, so there is exactly one rule in force and no chance of two
    /// drifting apart.
    /// </remarks>
    public const string RequireTier2 = RequireSupportUser;

    /// <summary>Supervisor. Guards the five decisions listed on this class.</summary>
    public const string RequireSupervisor = nameof(RequireSupervisor);

    /// <summary>
    /// The elevated database grant, which is separate from role and is
    /// consumed by nothing in this build.
    /// </summary>
    public const string RequireElevatedSql = nameof(RequireElevatedSql);

    /// <summary>
    /// The reserved hardware-actuation grant.
    /// </summary>
    /// <remarks>
    /// Registered, enforceable and consumed by no endpoint. It exists so that
    /// the permission is real and audited before anything can depend on it; the
    /// three reserved actuation actions are refused whether or not a caller
    /// holds it.
    /// </remarks>
    public const string RequireHardwareActuation = nameof(RequireHardwareActuation);

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

    /// <summary>
    /// Every policy this server registers.
    /// </summary>
    /// <remarks>
    /// The endpoint-coverage test walks the route table against this list, so a
    /// new endpoint that forgets its policy fails a test rather than relying on
    /// the default-deny fallback to catch it in production.
    /// </remarks>
    public static readonly IReadOnlyList<string> All = new[]
    {
        RequireSupportUser,
        RequireSupervisor,
        RequireElevatedSql,
        RequireHardwareActuation,
        RequireAgent,
        RequireAuthenticatedUser
    };
}

/// <summary>Requires a resolved role at or above <see cref="MinimumRole"/>.</summary>
public sealed class MinimumRoleRequirement : IAuthorizationRequirement
{
    public MinimumRoleRequirement(Role minimumRole) => MinimumRole = minimumRole;

    public Role MinimumRole { get; }
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
        if (Enum.TryParse(raw, ignoreCase: false, out Role role) &&
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

/// <summary>
/// Requires the reserved hardware-actuation grant, which is separate from role
/// and from every other grant.
/// </summary>
public sealed class HardwareActuationRequirement : IAuthorizationRequirement;

/// <summary>
/// Checks the hardware-actuation claim.
/// </summary>
/// <remarks>
/// A real handler for a real claim, registered and exercised by its own tests,
/// even though no endpoint currently carries the policy. A permission that
/// exists only as a column and a comment is one nobody can trust the day it
/// starts mattering.
/// </remarks>
public sealed class HardwareActuationHandler : AuthorizationHandler<HardwareActuationRequirement>
{
    /// <inheritdoc />
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        HardwareActuationRequirement requirement)
    {
        string? raw = context.User.FindFirst(SupportClaims.HardwareActuation)?.Value;

        if (string.Equals(raw, "true", StringComparison.OrdinalIgnoreCase))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

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
