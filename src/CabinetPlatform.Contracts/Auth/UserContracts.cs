using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Auth;

/// <summary>A user changing their own password.</summary>
/// <remarks>
/// Both values exist only for the moment of the change, on a TLS-protected
/// request. Neither is logged, audited or stored in any form other than the
/// salted hash the server keeps.
/// </remarks>
public sealed record ChangePasswordRequest
{
    /// <summary>The password in force now, proving the session belongs to its owner.</summary>
    public required string CurrentPassword { get; init; }

    /// <summary>The replacement, checked against the server's password policy.</summary>
    public required string NewPassword { get; init; }
}

/// <summary>A support user as the console displays them.</summary>
public sealed record UserDto
{
    /// <summary>Identifier of the user, as it appears in audit records.</summary>
    public required Guid Id { get; init; }

    /// <summary>Sign-in name.</summary>
    public required string Username { get; init; }

    /// <summary>Name shown in the console and in audit read-outs.</summary>
    public required string DisplayName { get; init; }

    /// <summary>Role granted to the user.</summary>
    public required Role Role { get; init; }

    /// <summary>Whether the user holds the elevated database grant.</summary>
    public required bool HasElevatedSql { get; init; }

    /// <summary>Whether the account may sign in at all.</summary>
    public required bool IsActive { get; init; }

    /// <summary>Whether the next sign-in must be followed by a password change.</summary>
    public required bool MustChangePassword { get; init; }

    /// <summary>UTC instant the account was created.</summary>
    public required DateTimeOffset CreatedUtc { get; init; }

    /// <summary>Who created it, or <see langword="null"/> for the seeded first Supervisor.</summary>
    public Guid? CreatedByUserId { get; init; }

    /// <summary>UTC instant of the last successful sign-in.</summary>
    public DateTimeOffset? LastLoginUtc { get; init; }

    /// <summary>Whether failed attempts have locked the account.</summary>
    public required bool IsLockedOut { get; init; }

    /// <summary>When that lockout lifts.</summary>
    public DateTimeOffset? LockedUntilUtc { get; init; }
}

/// <summary>Filter over the user list.</summary>
public sealed record UserQuery : PagedQuery
{
    /// <summary>Restrict to one role.</summary>
    public Role? Role { get; init; }

    /// <summary>Restrict to active or inactive accounts.</summary>
    public bool? IsActive { get; init; }
}

/// <summary>A Supervisor creating a support account.</summary>
public sealed record CreateUserRequest
{
    /// <summary>Sign-in name. Must be unique.</summary>
    public required string Username { get; init; }

    /// <summary>Name shown in the console.</summary>
    public required string DisplayName { get; init; }

    /// <summary>
    /// First password, checked against the policy. The account is flagged
    /// must-change, so this value buys exactly one sign-in and nothing else.
    /// </summary>
    public required string InitialPassword { get; init; }

    /// <summary>Role to grant.</summary>
    public required Role Role { get; init; }
}

/// <summary>A Supervisor amending a support account. Every member is optional.</summary>
public sealed record UpdateUserRequest
{
    /// <summary>New role, or <see langword="null"/> to leave it alone.</summary>
    public Role? Role { get; init; }

    /// <summary>New active flag, or <see langword="null"/> to leave it alone.</summary>
    public bool? IsActive { get; init; }

    /// <summary>New display name, or <see langword="null"/> to leave it alone.</summary>
    public string? DisplayName { get; init; }

    /// <summary>Clears an active lockout without touching the password.</summary>
    public bool? ClearLockout { get; init; }
}

/// <summary>A Supervisor granting or withdrawing the elevated database grant.</summary>
public sealed record ElevatedSqlRequest
{
    /// <summary>Whether to grant it or withdraw it.</summary>
    public required bool Grant { get; init; }

    /// <summary>
    /// Required. Granting elevated database access is exactly the kind of
    /// decision a compliance reviewer will want a stated justification for.
    /// </summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the decision is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}
