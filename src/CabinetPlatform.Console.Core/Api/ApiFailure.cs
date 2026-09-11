namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// Why a call to the server did not return data.
///
/// These are deliberately distinguishable rather than collapsed into one
/// "something went wrong". A support engineer staring at a cabinet needs to
/// know whether the clinic's network is down, their own token has expired, or
/// the server refused them — those three lead to three different next actions,
/// and a single generic error message hides which one they are in.
/// </summary>
public enum ApiFailure
{
    /// <summary>No HTTP response at all: DNS, TCP, TLS or a timeout.</summary>
    Unreachable,

    /// <summary>401. The token is missing, malformed or past its expiry.</summary>
    SessionExpired,

    /// <summary>
    /// 403 on a login attempt, where the server's wording says the credential
    /// was wrong rather than the account being locked.
    /// </summary>
    InvalidCredentials,

    /// <summary>403 on a login attempt for an account under an active lockout.</summary>
    AccountLocked,

    /// <summary>
    /// 403 on an authenticated call. The caller is who they say they are and
    /// may not do this — the server is the authority, and it said no.
    /// </summary>
    Forbidden,

    /// <summary>404.</summary>
    NotFound,

    /// <summary>400, including validation failures.</summary>
    Invalid,

    /// <summary>409. Well-formed but at odds with current state.</summary>
    Conflict,

    /// <summary>429. Rate limited; the caller should wait.</summary>
    RateLimited,

    /// <summary>5xx, or a response whose body could not be read as expected.</summary>
    ServerError
}
