namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// A failed call to the support server, carrying a reason the UI can act on and
/// a message it can show verbatim.
/// </summary>
/// <remarks>
/// The message is the server's own <c>ProblemDetails.detail</c> where there was
/// one. That matters: the server's refusals are written for a support engineer
/// to read ("Reboot machine requires the Tier2 role", "You cannot approve an
/// action you requested yourself"), and paraphrasing them in the client would
/// only lose information and risk saying something the server did not mean.
/// </remarks>
public sealed class ApiException : Exception
{
    public ApiException(ApiFailure failure, string message, int? statusCode = null, Exception? inner = null)
        : base(message, inner)
    {
        Failure = failure;
        StatusCode = statusCode;
    }

    public ApiFailure Failure { get; }

    /// <summary>The HTTP status, or null when no response was received.</summary>
    public int? StatusCode { get; }

    /// <summary>
    /// True when re-authenticating is the fix. The shell watches for this and
    /// returns the user to the sign-in screen rather than showing an error that
    /// looks like a server fault.
    /// </summary>
    public bool RequiresReauthentication => Failure == ApiFailure.SessionExpired;
}
