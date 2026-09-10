namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// What the server returns for a successful sign-in.
/// </summary>
/// <remarks>
/// A failed sign-in is answered with an HTTP failure status and no body, so
/// there is no shape here for representing a rejected attempt — and no way to
/// mistake one for a successful one.
/// </remarks>
public sealed record LoginResponse
{
    /// <summary>Bearer token the console presents on subsequent requests.</summary>
    public required string AccessToken { get; init; }

    /// <summary>UTC instant after which the token is no longer accepted.</summary>
    public required DateTimeOffset ExpiresAtUtc { get; init; }

    /// <summary>Identifier of the signed-in user, as it will appear in audit records.</summary>
    public required string UserId { get; init; }

    /// <summary>The user's display name, for the console's title bar and audit read-outs.</summary>
    public required string DisplayName { get; init; }

    /// <summary>
    /// Role granted to the user. The console uses it to shape what it shows;
    /// the server still authorises every request on its own.
    /// </summary>
    public required Role Role { get; init; }
}
