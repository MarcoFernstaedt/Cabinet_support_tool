using System.Text.RegularExpressions;
using CabinetPlatform.Agent.Configuration;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions;

/// <summary>
/// The agent's own list of services it will start, stop or restart.
/// </summary>
/// <remarks>
/// <para>
/// The server validates the target too. This list exists because the server
/// validating it is not the same as the agent being safe: a compromised server,
/// or simply a bug in one, must not be able to stop a cabinet's dispensing
/// service or its BitLocker provider. Two independent checks fail independently.
/// </para>
/// <para>
/// The list is configuration rather than a constant because which services
/// matter differs between a CUBEX and a ZIMBIS cabinet. It is deployment
/// configuration on the machine, not something the server can influence.
/// </para>
/// </remarks>
public sealed class ServiceNameAllowList
{
    /// <summary>
    /// Windows service names are restricted to this shape.
    /// </summary>
    /// <remarks>
    /// Checked before the name is compared to the list, so that a value
    /// containing path separators, quotes or control characters is rejected on
    /// sight rather than being handed to the service control manager.
    /// </remarks>
    private static readonly Regex ValidServiceName = new(
        @"^[A-Za-z0-9_.\-]{1,256}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private readonly HashSet<string> _allowed;

    public ServiceNameAllowList(IOptions<AgentOptions> options)
    {
        _allowed = new HashSet<string>(
            options.Value.Actions.ServiceAllowList
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(name => name.Trim()),
            StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>The services this agent will act on.</summary>
    public IReadOnlyCollection<string> Allowed => _allowed;

    /// <summary>
    /// Checks a requested service name.
    /// </summary>
    /// <param name="failureReason">
    /// Names the service that was refused, so an engineer reading the audit
    /// trail can see what was asked for rather than only that it was denied.
    /// </param>
    public bool IsAllowed(string serviceName, out string failureReason)
    {
        if (string.IsNullOrWhiteSpace(serviceName))
        {
            failureReason = "No service name was supplied.";
            return false;
        }

        var candidate = serviceName.Trim();

        if (!ValidServiceName.IsMatch(candidate))
        {
            failureReason = "The service name is not a valid Windows service name.";
            return false;
        }

        if (_allowed.Count == 0)
        {
            // An empty list denies everything. A misconfigured agent that
            // silently permitted every service would be far worse than one that
            // refuses until somebody configures it.
            failureReason =
                $"The agent's service allow-list is empty, so '{candidate}' cannot be acted on. " +
                "Configure Agent:Actions:ServiceAllowList on this machine.";
            return false;
        }

        if (!_allowed.Contains(candidate))
        {
            failureReason = $"The service '{candidate}' is not in this agent's allow-list.";
            return false;
        }

        failureReason = string.Empty;
        return true;
    }
}
