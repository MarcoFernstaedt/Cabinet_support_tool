namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// An exchange of a refresh token for a fresh access token.
/// </summary>
/// <remarks>
/// <para>
/// This is the one place in the request path that touches the database for
/// authorisation state, and it is deliberate. The access token is stateless so
/// the server stays horizontally scalable; the refresh is where the user's
/// <em>current</em> role, elevated grant and active flag are re-read. Claims
/// baked in at sign-in are never trusted past one access-token lifetime.
/// </para>
/// <para>
/// Refresh tokens rotate: the presented token is consumed and a new one is
/// issued. Presenting a consumed token revokes the whole chain and writes an
/// audit row, because it is either a client bug or a stolen token, and both
/// are worth ending the session over.
/// </para>
/// </remarks>
public sealed record RefreshRequest
{
    /// <summary>The refresh token last issued to this client.</summary>
    public required string RefreshToken { get; init; }
}

/// <summary>The new token pair, and the permission state it was minted against.</summary>
public sealed record RefreshResponse
{
    /// <summary>A fresh access token.</summary>
    public required string AccessToken { get; init; }

    /// <summary>UTC instant after which the access token is no longer accepted.</summary>
    public required DateTimeOffset ExpiresAtUtc { get; init; }

    /// <summary>The replacement refresh token. The presented one is now consumed.</summary>
    public required string RefreshToken { get; init; }

    /// <summary>UTC instant after which the refresh token is no longer accepted.</summary>
    public required DateTimeOffset RefreshTokenExpiresAtUtc { get; init; }

    /// <summary>Identifier of the user the tokens belong to.</summary>
    public required Guid UserId { get; init; }

    /// <summary>The user's display name, re-read at refresh time.</summary>
    public required string DisplayName { get; init; }

    /// <summary>The user's role as it stands now, not as it stood at sign-in.</summary>
    public required Role Role { get; init; }

    /// <summary>The elevated grant as it stands now.</summary>
    public required bool HasElevatedSql { get; init; }

    /// <summary>Whether the user must still change their password.</summary>
    public required bool MustChangePassword { get; init; }
}

/// <summary>
/// A Supervisor ending every session a user holds, immediately.
/// </summary>
/// <remarks>
/// Effective access ends within one access-token lifetime: the refresh chain is
/// dead at once, and the outstanding access token expires on its own. This is
/// the lockout path for an offboarded rep.
/// </remarks>
public sealed record RevokeUserSessionsRequest
{
    /// <summary>Why the sessions were ended. Required, and audited.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the revocation is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}
