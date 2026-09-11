namespace CabinetPlatform.Server.Domain;

/// <summary>
/// A server-side refresh token: the one piece of session state this design
/// keeps, and deliberately the only one.
/// </summary>
/// <remarks>
/// <para>
/// Access tokens are stateless and short-lived, so the request path never hits
/// the database to authorise anything and the server stays horizontally
/// scalable. Refresh is where the user's <em>current</em> role, elevated grant
/// and active flag are re-read. That is the whole point: when a Supervisor
/// withdraws an elevated grant or disables an offboarded rep, effective access
/// ends within one access-token lifetime rather than whenever a long-lived
/// token happens to expire.
/// </para>
/// <para>
/// Tokens rotate on use. Presenting one that has already been consumed revokes
/// every token in its chain and writes an audit row, because a replayed refresh
/// is either a client bug or a stolen token and both are worth ending the
/// session over.
/// </para>
/// <para>
/// Only a hash is stored. A database disclosure must not hand anybody a usable
/// session.
/// </para>
/// </remarks>
public class RefreshToken
{
    /// <summary>Identifier of the token row.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>The user this token authenticates.</summary>
    public Guid UserId { get; set; }

    /// <summary>Navigation to that user.</summary>
    public User? User { get; set; }

    /// <summary>
    /// Every token descended from one sign-in shares this. Revoking a chain
    /// ends the session no matter how many times the token has rotated.
    /// </summary>
    public Guid ChainId { get; set; }

    /// <summary>SHA-256 of the token value. The value itself is never stored.</summary>
    public byte[] TokenHash { get; set; } = Array.Empty<byte>();

    /// <summary>UTC instant it was issued.</summary>
    public DateTimeOffset IssuedUtc { get; set; }

    /// <summary>UTC instant after which it is refused even if never used.</summary>
    public DateTimeOffset ExpiresUtc { get; set; }

    /// <summary>UTC instant it was exchanged, after which presenting it is reuse.</summary>
    public DateTimeOffset? ConsumedUtc { get; set; }

    /// <summary>UTC instant it was revoked, if it was.</summary>
    public DateTimeOffset? RevokedUtc { get; set; }

    /// <summary>Why it was revoked, for the audit trail.</summary>
    public string? RevokedReason { get; set; }

    /// <summary>The token issued in its place when it was consumed.</summary>
    public Guid? ReplacedByTokenId { get; set; }

    /// <summary>Whether this token may still be exchanged.</summary>
    /// <param name="nowUtc">The current instant.</param>
    public bool IsUsable(DateTimeOffset nowUtc) =>
        ConsumedUtc is null && RevokedUtc is null && ExpiresUtc > nowUtc;
}
