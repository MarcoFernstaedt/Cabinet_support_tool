using System.Net.Http.Headers;

namespace Mashura.CabinetSupport.Console.Core.Api;

/// <summary>
/// Attaches the session's bearer token to every outgoing request.
/// </summary>
/// <remarks>
/// It lives in the handler pipeline rather than in <see cref="ApiClient"/> so
/// that there is no way to write a call that forgets it, and no second place
/// the token has to be read from.
/// </remarks>
public sealed class BearerTokenHandler : DelegatingHandler
{
    private readonly ISessionStore _session;

    public BearerTokenHandler(ISessionStore session) => _session = session;

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        // Login is the one call that must go out without one; it is also the
        // call that produces one.
        if (_session.AccessToken is { Length: > 0 } token)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        return base.SendAsync(request, cancellationToken);
    }
}
