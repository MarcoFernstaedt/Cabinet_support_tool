using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// In-memory session state. Registered as a singleton for the life of the
/// process and cleared on sign-out and on exit.
/// </summary>
/// <remarks>
/// The token is a <see cref="string"/>, so <see cref="SignOut"/> drops the
/// console's last reference to it rather than scrubbing the bytes — the CLR
/// interns nothing here, but the old string survives until it is collected.
/// That is stated plainly rather than dressed up: the guarantee this class
/// offers is "never persisted, and unreachable after sign-out", not "erased
/// from RAM". Reaching for <c>SecureString</c> would buy the appearance of the
/// stronger guarantee without the substance, since the value has to be handed
/// to an HTTP header as plaintext on every request anyway.
/// </remarks>
public sealed class SessionStore : ISessionStore
{
    private readonly object _gate = new();

    private string? _accessToken;
    private DateTime? _expiresUtc;
    private Guid? _userId;
    private string? _username;
    private string? _displayName;
    private Role? _role;
    private bool _mustChangePassword;

    public string? AccessToken { get { lock (_gate) { return _accessToken; } } }
    public DateTime? ExpiresUtc { get { lock (_gate) { return _expiresUtc; } } }
    public Guid? UserId { get { lock (_gate) { return _userId; } } }
    public string? Username { get { lock (_gate) { return _username; } } }
    public string? DisplayName { get { lock (_gate) { return _displayName; } } }
    public Role? Role { get { lock (_gate) { return _role; } } }
    public bool MustChangePassword { get { lock (_gate) { return _mustChangePassword; } } }

    public bool IsSignedIn { get { lock (_gate) { return _accessToken is { Length: > 0 }; } } }

    public event EventHandler? Changed;

    public void SignIn(
        string accessToken, DateTime expiresUtc, string displayName, Role role, bool mustChangePassword)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(accessToken);

        lock (_gate)
        {
            _accessToken = accessToken;
            _expiresUtc = expiresUtc;
            _displayName = displayName;
            _role = role;
            _mustChangePassword = mustChangePassword;
        }

        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void AttachIdentity(Guid userId, string username, Role role, bool mustChangePassword)
    {
        lock (_gate)
        {
            _userId = userId;
            _username = username;
            _role = role;
            _mustChangePassword = mustChangePassword;
        }

        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void MarkPasswordChanged()
    {
        lock (_gate)
        {
            _mustChangePassword = false;
        }

        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void SignOut()
    {
        lock (_gate)
        {
            _accessToken = null;
            _expiresUtc = null;
            _userId = null;
            _username = null;
            _displayName = null;
            _role = null;
            _mustChangePassword = false;
        }

        Changed?.Invoke(this, EventArgs.Empty);
    }
}
