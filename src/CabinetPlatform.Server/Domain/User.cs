using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Server.Domain;

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

    public Role Role { get; set; } = Role.Tier1;

    public bool HasElevatedSql { get; set; }

    /// <summary>
    /// The reserved hardware-actuation grant. Nothing in this build consumes
    /// it.
    /// </summary>
    /// <remarks>
    /// It is a separate column rather than a role because actuating a lock on a
    /// cabinet holding controlled substances is not a tier of support work, it
    /// is a different kind of authority. Keeping the grant real and audited now
    /// means the day an actuation feature is designed it inherits a permission
    /// with a history, rather than acquiring one written in a hurry beside it.
    /// </remarks>
    public bool HasHardwareActuation { get; set; }

    public bool IsActive { get; set; } = true;

    /// <summary>Forces a password change before anything else is permitted.</summary>
    public bool MustChangePassword { get; set; }

    public DateTimeOffset CreatedUtc { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Null only for the bootstrap Supervisor the server seeds itself.</summary>
    public Guid? CreatedByUserId { get; set; }

    public DateTimeOffset? LastLoginUtc { get; set; }

    public int FailedLoginCount { get; set; }

    public DateTimeOffset? LockedUntilUtc { get; set; }

    /// <summary>Whether failed attempts currently bar this account.</summary>
    /// <param name="nowUtc">The current instant.</param>
    public bool IsLockedOut(DateTimeOffset nowUtc) => LockedUntilUtc.HasValue && LockedUntilUtc.Value > nowUtc;

    /// <summary>
    /// Optimistic concurrency token over the permission fields.
    /// </summary>
    /// <remarks>
    /// Two Supervisors changing the same account's role or elevated grant at
    /// once must not have one decision silently overwrite the other. A version
    /// conflict returns a clear error and the second Supervisor re-reads.
    /// </remarks>
    public byte[]? RowVersion { get; set; }

    /// <summary>Refresh tokens issued to this user.</summary>
    public ICollection<RefreshToken> RefreshTokens { get; set; } = new List<RefreshToken>();
}
