using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Mashura.CabinetSupport.Server.Security;

public sealed class AgentAuthOptions
{
    public const string SectionName = "AgentAuth";

    public string HeaderName { get; set; } = "X-Mashura-Agent-Key";

    /// <summary>
    /// Never hard-coded and never committed. Supplied per deployment through
    /// configuration — an environment variable or the platform's secret store.
    /// The server refuses to start without it.
    /// </summary>
    public string? SharedSecret { get; set; }

    /// <summary>Header carrying the machine identity the agent claims.</summary>
    public string MachineIdHeaderName { get; set; } = "X-Mashura-Machine-Id";
}

/// <summary>
/// The result of deciding whether a request really came from a fleet agent.
/// </summary>
public sealed record AgentIdentity(bool IsAuthenticated, string? MachineId, string? FailureReason)
{
    public static AgentIdentity Fail(string reason) => new(false, null, reason);
    public static AgentIdentity Success(string machineId) => new(true, machineId, null);
}

/// <summary>
/// The single seam where agent identity is established.
///
/// This build proves an agent by a shared secret in a header. Mutual TLS with
/// a per-cabinet client certificate is the planned upgrade, and this interface
/// exists so that upgrade touches exactly one implementation: no controller,
/// no policy and no audit path reads the header directly.
/// </summary>
public interface IAgentAuthenticator
{
    AgentIdentity Authenticate(HttpContext context);
}

public sealed class SharedSecretAgentAuthenticator : IAgentAuthenticator
{
    private readonly AgentAuthOptions _options;
    private readonly byte[] _expectedSecret;

    public SharedSecretAgentAuthenticator(IOptions<AgentAuthOptions> options)
    {
        _options = options.Value;

        if (string.IsNullOrWhiteSpace(_options.SharedSecret))
        {
            // Starting with agent auth disabled would silently open the whole
            // check-in surface, so this is a startup failure, not a warning.
            throw new InvalidOperationException(
                $"{AgentAuthOptions.SectionName}:SharedSecret is not configured. " +
                "Supply it through environment configuration or a secret store.");
        }

        _expectedSecret = Encoding.UTF8.GetBytes(_options.SharedSecret);
    }

    public AgentIdentity Authenticate(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue(_options.HeaderName, out var presented) ||
            presented.Count != 1 ||
            string.IsNullOrEmpty(presented[0]))
        {
            return AgentIdentity.Fail("Agent key header missing.");
        }

        byte[] candidate = Encoding.UTF8.GetBytes(presented[0]!);

        // Constant-time, and length-independent: FixedTimeEquals returns false
        // for a length mismatch without comparing, so hash both sides to a
        // fixed width first rather than leaking the secret's length.
        if (!CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(candidate),
                SHA256.HashData(_expectedSecret)))
        {
            return AgentIdentity.Fail("Agent key invalid.");
        }

        if (!context.Request.Headers.TryGetValue(_options.MachineIdHeaderName, out var machineId) ||
            machineId.Count != 1 ||
            string.IsNullOrWhiteSpace(machineId[0]))
        {
            return AgentIdentity.Fail("Machine id header missing.");
        }

        string value = machineId[0]!.Trim();

        if (value.Length > 128)
        {
            return AgentIdentity.Fail("Machine id is too long.");
        }

        return AgentIdentity.Success(value);
    }
}

public sealed class AgentAuthenticationSchemeOptions : AuthenticationSchemeOptions;

/// <summary>
/// Bridges <see cref="IAgentAuthenticator"/> into the standard authentication
/// pipeline so that agent endpoints carry a real
/// <c>[Authorize(Policy = RequireAgent)]</c> attribute like everything else,
/// rather than sitting outside the authorization system.
/// </summary>
public sealed class AgentAuthenticationHandler
    : AuthenticationHandler<AgentAuthenticationSchemeOptions>
{
    public const string SchemeName = "MashuraAgent";

    /// <summary>
    /// Claim carrying the machine id the agent presented. It is an assertion
    /// under a valid key, not proof of approval: every agent endpoint still
    /// resolves the cabinet from the database and checks it is approved.
    /// </summary>
    public const string MachineIdClaimType = "mashura:machine_id";

    private readonly IAgentAuthenticator _authenticator;

    public AgentAuthenticationHandler(
        IOptionsMonitor<AgentAuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IAgentAuthenticator authenticator)
        : base(options, logger, encoder)
    {
        _authenticator = authenticator;
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        AgentIdentity identity = _authenticator.Authenticate(Context);

        if (!identity.IsAuthenticated)
        {
            // NoResult, not Fail: an unauthenticated request should produce a
            // clean 401 from the policy rather than an exception-shaped 500.
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var claims = new[]
        {
            new Claim(MachineIdClaimType, identity.MachineId!),
            new Claim(ClaimTypes.NameIdentifier, identity.MachineId!)
        };

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
        return Task.FromResult(
            AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }
}
