using System.Collections.Immutable;
using Microsoft.Extensions.Options;

namespace Mashura.CabinetSupport.Server.Actions;

public sealed class ServiceAllowListOptions
{
    public const string SectionName = "ServiceAllowList";

    /// <summary>
    /// Windows service names support staff may start, stop or restart.
    ///
    /// This is an allow-list, not a deny-list, and it is deployment
    /// configuration rather than a request parameter: nothing a caller sends
    /// can add to it. The defaults cover the cabinet application stack and the
    /// handful of platform services that legitimately need bouncing.
    /// </summary>
    public List<string> Services { get; set; } = new()
    {
        "MashuraCabinetAgent",
        "MashuraCabinetService",
        "MashuraDispenseController",
        "MashuraSyncService",
        "Spooler",
        "W32Time",
        "Dnscache",
        "wuauserv",
        "BITS"
    };
}

/// <summary>
/// Validates a requested service name against the deployment's allow-list.
/// A name that is not on the list is refused; it is never "sanitised" and
/// passed along, because a sanitised arbitrary service name is still an
/// arbitrary service name.
/// </summary>
public interface IServiceAllowList
{
    bool IsAllowed(string? serviceName);
    IReadOnlyCollection<string> AllowedServices { get; }
}

public sealed class ServiceAllowList : IServiceAllowList
{
    private readonly ImmutableHashSet<string> _services;

    public ServiceAllowList(IOptions<ServiceAllowListOptions> options)
    {
        _services = options.Value.Services
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public IReadOnlyCollection<string> AllowedServices => _services;

    public bool IsAllowed(string? serviceName) =>
        !string.IsNullOrWhiteSpace(serviceName) && _services.Contains(serviceName.Trim());
}
