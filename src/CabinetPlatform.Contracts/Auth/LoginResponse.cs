namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// What the server returns for a successful sign-in.
/// </summary>
/// <remarks>
/// <para>
/// A failed sign-in is answered with an HTTP failure status and no body, so
/// there is no shape here for representing a rejected attempt — and no way to
/// mistake one for a successful one.
/// </para>
/// <para>
/// Note what is absent: no role or permission the client can edit and send
/// back. These fields drive what the console draws, never what the server
/// allows — the server re-resolves the principal on every single request.
/// </para>
/// </remarks>
public sealed record LoginResponse
{
    /// <summary>
    /// Bearer token the console presents on subsequent requests. Short-lived
    /// and stateless: it is never checked against the database on the request
    /// path.
    /// </summary>
    public required string AccessToken { get; init; }

    /// <summary>UTC instant after which the access token is no longer accepted.</summary>
    public required DateTimeOffset ExpiresAtUtc { get; init; }

    /// <summary>
    /// Opaque token used to obtain the next access token. It is stored
    /// server-side, checked on every use, and rotates each time it is used.
    /// </summary>
    public required string RefreshToken { get; init; }

    /// <summary>UTC instant after which the refresh token is no longer accepted.</summary>
    public required DateTimeOffset RefreshTokenExpiresAtUtc { get; init; }

    /// <summary>Identifier of the signed-in user, as it will appear in audit records.</summary>
    public required Guid UserId { get; init; }

    /// <summary>The user's display name, for the console's title bar and audit read-outs.</summary>
    public required string DisplayName { get; init; }

    /// <summary>
    /// Role granted to the user. The console uses it to shape what it shows;
    /// the server still authorises every request on its own.
    /// </summary>
    public required Role Role { get; init; }

    /// <summary>
    /// Whether the user holds the elevated database grant, which is separate
    /// from role. It never permits running a query someone typed.
    /// </summary>
    public required bool HasElevatedSql { get; init; }

    /// <summary>
    /// Set for the seeded first Supervisor and after any password reset. The
    /// console must route the user straight to a change-password screen; the
    /// server independently refuses everything else until they do.
    /// </summary>
    public required bool MustChangePassword { get; init; }
}
