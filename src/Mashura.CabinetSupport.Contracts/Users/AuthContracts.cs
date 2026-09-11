using System.ComponentModel.DataAnnotations;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Contracts.Users;

public sealed class LoginRequest
{
    [Required, StringLength(64, MinimumLength = 1)]
    public string Username { get; set; } = string.Empty;

    [Required, StringLength(256, MinimumLength = 1)]
    public string Password { get; set; } = string.Empty;
}

/// <summary>
/// Note what is absent: no role or permission the client can edit and send
/// back. These fields drive what the console draws, never what the server
/// allows — the server re-resolves the principal on every single request.
/// </summary>
public sealed class LoginResponse
{
    public string AccessToken { get; set; } = string.Empty;
    public DateTime ExpiresUtc { get; set; }
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public bool HasElevatedSql { get; set; }

    /// <summary>
    /// Set for the seeded first Supervisor and any password reset. The console
    /// must route the user straight to a change-password screen.
    /// </summary>
    public bool MustChangePassword { get; set; }
}

public sealed class ChangePasswordRequest
{
    [Required, StringLength(256, MinimumLength = 1)]
    public string CurrentPassword { get; set; } = string.Empty;

    [Required, StringLength(256, MinimumLength = 1)]
    public string NewPassword { get; set; } = string.Empty;
}

public sealed class UserDto
{
    public Guid Id { get; set; }
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public bool HasElevatedSql { get; set; }
    public bool IsActive { get; set; }
    public bool MustChangePassword { get; set; }
    public DateTime CreatedUtc { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public DateTime? LastLoginUtc { get; set; }
    public bool IsLockedOut { get; set; }
    public DateTime? LockedUntilUtc { get; set; }
}

public sealed class CreateUserRequest
{
    [Required, StringLength(64, MinimumLength = 3)]
    public string Username { get; set; } = string.Empty;

    [Required, StringLength(128, MinimumLength = 1)]
    public string DisplayName { get; set; } = string.Empty;

    [Required, StringLength(256, MinimumLength = 1)]
    public string InitialPassword { get; set; } = string.Empty;

    [Required]
    public UserRole Role { get; set; }
}

public sealed class UpdateUserRequest
{
    public UserRole? Role { get; set; }
    public bool? IsActive { get; set; }

    [StringLength(128, MinimumLength = 1)]
    public string? DisplayName { get; set; }

    /// <summary>Clears an active lockout without touching the password.</summary>
    public bool? ClearLockout { get; set; }
}

public sealed class ElevatedSqlRequest
{
    [Required]
    public bool Grant { get; set; }

    /// <summary>
    /// Required. Granting elevated database access is exactly the kind of
    /// decision a compliance reviewer will want a stated justification for.
    /// </summary>
    [Required, StringLength(1000, MinimumLength = 3)]
    public string Reason { get; set; } = string.Empty;

    [StringLength(64)]
    public string? TicketReference { get; set; }
}
