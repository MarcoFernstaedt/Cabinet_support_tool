using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Server.Domain;

public class User
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Username { get; set; } = string.Empty;

    /// <summary>PBKDF2-derived key. Never logged, never returned by any endpoint.</summary>
    public byte[] PasswordHash { get; set; } = Array.Empty<byte>();

    /// <summary>Per-user salt. Never reused between users or across resets.</summary>
    public byte[] PasswordSalt { get; set; } = Array.Empty<byte>();

    /// <summary>
    /// Stored alongside the hash so the iteration count can be raised later
    /// without invalidating existing credentials — old hashes verify with their
    /// original cost and are upgraded on the next successful login.
    /// </summary>
    public int PasswordIterations { get; set; }

    public string DisplayName { get; set; } = string.Empty;

    public UserRole Role { get; set; } = UserRole.Tier1;

    public bool HasElevatedSql { get; set; }

    public bool IsActive { get; set; } = true;

    /// <summary>Forces a password change before anything else is permitted.</summary>
    public bool MustChangePassword { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    /// <summary>Null only for the bootstrap Supervisor the server seeds itself.</summary>
    public Guid? CreatedByUserId { get; set; }

    public DateTime? LastLoginUtc { get; set; }

    public int FailedLoginCount { get; set; }

    public DateTime? LockedUntilUtc { get; set; }

    public bool IsLockedOut(DateTime nowUtc) => LockedUntilUtc.HasValue && LockedUntilUtc.Value > nowUtc;
}
