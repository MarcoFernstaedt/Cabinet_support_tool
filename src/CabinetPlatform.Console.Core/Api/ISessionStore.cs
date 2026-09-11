using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// The signed-in user's token and the identity facts the console draws with.
/// </summary>
/// <remarks>
/// <para>
/// Nothing here is ever written to disk, to the registry, to a settings file or
/// to a log. There is no "remember me" and no credential cache, by design: a
/// support console holds a token that can reach every clinic in the fleet, and
/// the machine it runs on is an ordinary office desktop.
/// </para>
/// <para>
/// <see cref="Role"/> is held only so the UI can grey out controls the server
/// would refuse. It is never sent back to the server and never consulted as an
/// authorization decision — the server re-resolves the principal on every
/// request, and a console that disagreed with it would simply be wrong on
/// screen, not permitted.
/// </para>
/// </remarks>
public interface ISessionStore
{
    /// <summary>The bearer token, or null when signed out.</summary>
    string? AccessToken { get; }

    DateTime? ExpiresUtc { get; }

    Guid? UserId { get; }
    string? Username { get; }
    string? DisplayName { get; }
    Role? Role { get; }

    /// <summary>
    /// True while the session may only change its own password. The server
    /// enforces this — every role policy carries a password-not-expired
    /// requirement — so the console follows rather than decides.
    /// </summary>
    bool MustChangePassword { get; }

    bool IsSignedIn { get; }

    /// <summary>Raised whenever sign-in state changes, so the shell can react.</summary>
    event EventHandler? Changed;

    void SignIn(string accessToken, DateTime expiresUtc, string displayName, Role role, bool mustChangePassword);

    /// <summary>
    /// Fills in the facts only <c>GET /api/auth/me</c> carries — chiefly the
    /// user id, which the Approvals view needs to recognise the user's own
    /// requests. The token is untouched.
    /// </summary>
    void AttachIdentity(Guid userId, string username, Role role, bool mustChangePassword);

    /// <summary>Clears the password-change flag after the server accepted a change.</summary>
    void MarkPasswordChanged();

    /// <summary>Drops the token and every identity fact. Called on sign-out and on app exit.</summary>
    void SignOut();
}
