using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// Supplies the shared secret the server authenticates this agent by.
/// </summary>
/// <remarks>
/// Deliberately not part of <see cref="AgentOptions"/>. Everything in the
/// options file is configuration a deployment may edit and a support engineer
/// may read; this is a credential, and it comes from the machine's own
/// environment or secret store so that it never lands in a committed file, a
/// log line or a diagnostic bundle.
/// </remarks>
public interface IAgentCredentialProvider
{
    /// <summary>
    /// The agent key, or null when the machine has not been given one.
    /// </summary>
    string? GetAgentKey();
}

/// <inheritdoc />
public sealed class EnvironmentAgentCredentialProvider : IAgentCredentialProvider
{
    /// <summary>
    /// Environment variable the installer writes the key into, machine-scoped.
    /// </summary>
    public const string VariableName = "CABINET_AGENT_KEY";

    private readonly ILogger<EnvironmentAgentCredentialProvider> _logger;
    private bool _warned;

    /// <summary>Creates the provider.</summary>
    /// <param name="logger">Diagnostic log.</param>
    public EnvironmentAgentCredentialProvider(ILogger<EnvironmentAgentCredentialProvider> logger) =>
        _logger = logger;

    /// <inheritdoc />
    public string? GetAgentKey()
    {
        string? key = Environment.GetEnvironmentVariable(VariableName);

        if (!string.IsNullOrWhiteSpace(key))
        {
            return key.Trim();
        }

        if (!_warned)
        {
            // Said once, not once per request: a cabinet with no key will fail
            // every call, and repeating it fills the log with the same line
            // instead of the one that explains it.
            _warned = true;
            _logger.LogError(
                "{Variable} is not set, so every call to the server will be refused. The installer " +
                "supplies it from the deployment's secret store.",
                VariableName);
        }

        return null;
    }
}

/// <summary>
/// Attaches the agent's identity to every outbound request.
/// </summary>
/// <remarks>
/// <para>
/// Both headers are required by the server on every agent endpoint. Presenting
/// the key proves the caller is <em>some</em> agent in this fleet; the machine
/// id says which one, and the server resolves the cabinet from that identity
/// rather than from anything in the request body.
/// </para>
/// <para>
/// A handler rather than a header set once at client construction, because the
/// key is read from the environment on each call: rotating it should not need
/// a service restart.
/// </para>
/// </remarks>
public sealed class AgentAuthenticationHandler : DelegatingHandler
{
    private readonly IAgentCredentialProvider _credentials;
    private readonly IMachineIdentityProvider _identity;
    private readonly AgentOptions _options;

    /// <summary>Creates the handler.</summary>
    /// <param name="credentials">Supplies the agent key.</param>
    /// <param name="identity">Supplies the machine id.</param>
    /// <param name="options">Header names, matched to the server's configuration.</param>
    public AgentAuthenticationHandler(
        IAgentCredentialProvider credentials,
        IMachineIdentityProvider identity,
        IOptions<AgentOptions> options)
    {
        _credentials = credentials;
        _identity = identity;
        _options = options.Value;
    }

    /// <inheritdoc />
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string? key;
        if (_credentials is OfficeAgentCredentialProvider office)
        {
            office.ValidateDestination(request.RequestUri);
            key = await office.EnsureKeyAsync(cancellationToken).ConfigureAwait(false);
        }
        else
        {
            key = _credentials.GetAgentKey();
        }

        if (key is not null)
        {
            request.Headers.Remove(_options.AgentKeyHeaderName);
            request.Headers.Add(_options.AgentKeyHeaderName, key);
        }

        request.Headers.Remove(_options.MachineIdHeaderName);
        request.Headers.Add(_options.MachineIdHeaderName, _identity.GetMachineId());

        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
