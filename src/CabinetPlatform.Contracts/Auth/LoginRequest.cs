namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// Credentials a support user presents to sign in to the platform.
/// </summary>
/// <remarks>
/// <see cref="Password"/> exists only for the moment of authentication, on a
/// TLS-protected request. It is never logged, never written to the audit
/// trail, and never stored in any form other than a salted hash held by the
/// server's user store.
/// </remarks>
public sealed record LoginRequest
{
    /// <summary>The user's sign-in name.</summary>
    public required string Username { get; init; }

    /// <summary>The user's password, in transit only.</summary>
    public required string Password { get; init; }
}
