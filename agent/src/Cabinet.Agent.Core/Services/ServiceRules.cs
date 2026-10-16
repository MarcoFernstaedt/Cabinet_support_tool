using System.Text.RegularExpressions;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Services;

/// <summary>What Windows can tell about one service, and do to it. Implemented by the Windows service manager on a cabinet.</summary>
public interface IServicePlatform
{
    IReadOnlyList<ServiceInfo> List();
    /// <summary>
    /// The service's key name when <paramref name="name"/> is exactly a key name (ignoring case), else null. Windows also
    /// accepts a display name ("Remote Desktop Services" for TermService); the agent never does, so the refused list
    /// cannot be got round by naming a service another way.
    /// </summary>
    string? KeyName(string name);
    /// <summary>The service's state and start type, or null when no such service exists.</summary>
    (ServiceState State, ServiceStartType StartType)? Query(string name);
    /// <summary>Starts the service and waits (bounded) for it to run. Throws <see cref="ServiceControlException"/> with the Windows error code.</summary>
    void Start(string name);
    void Stop(string name);
    /// <summary>Sets the start type (automatic, delayed automatic, manual or disabled). Throws <see cref="ServiceControlException"/> with the Windows error code.</summary>
    void SetStartType(string name, ServiceStartType startType);
}

/// <summary>A start or stop Windows refused, with its Windows error code.</summary>
public sealed class ServiceControlException(long code, string message) : Exception(message)
{
    public long Code { get; } = code;
}

/// <summary>
/// The services the agent never touches (docs/spec/12-milestones-8-to-12.md): its own, which change only by a signed
/// upgrade, and remote-access services, which stay as an administrator at the cabinet left them. Compiled in, so the
/// server cannot change it.
/// </summary>
public static class ServiceRules
{
    public static readonly IReadOnlySet<string> Refused = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "CabinetAgentBroker", "CabinetAgentNetwork",
        "TermService", "UmRdpService", "SessionEnv", "RemoteRegistry", "WinRM", "RemoteAccess", "sshd", "ssh-agent", "TlntSvr",
        "vncserver", "uvnc_service", "tvnserver", "winvnc", "RealVNC", "TeamViewer", "AnyDesk",
    };

    private static readonly Regex Name = new("^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));

    /// <summary>The same rule as the contract's serviceName, checked again before any name reaches Windows.</summary>
    public static bool IsValidName(string? name) => name is not null && Name.IsMatch(name);

    public static bool IsRefused(string name) => Refused.Contains(name);
}

/// <summary>service.control as the broker runs it: start, stop or restart one service, within the rules above.</summary>
public sealed class ServiceControl(IServicePlatform platform, Action<string> log)
{
    public OperationRegistry Register(OperationRegistry registry) => registry
        .Register<ServiceControlParams, ServiceControlOutput>(Catalog.ServiceControl, (p, _) => Task.FromResult(Run(p)))
        .Register<ServiceSetStartTypeParams, ServiceSetStartTypeOutput>(Catalog.ServiceSetStartType, (p, _) => Task.FromResult(SetStartType(p)))
        .Register<EmptyParams, ServicesListOutput>(Catalog.ServicesList, (_, _) => Task.FromResult(List()));

    /// <summary>The watcher whose status services.list reports; set by the broker when it starts.</summary>
    public ServiceWatcher? Watcher { get; set; }

    public ServicesListOutput List() => new()
    {
        Services = platform.List().OrderBy(s => s.DisplayName, StringComparer.OrdinalIgnoreCase).Take(1000).ToList(),
        Watched = Watcher?.Status() ?? [],
    };

    /// <summary>service.setStartType: the same refused list and exact key names as service.control; drivers (boot and system) are never changed.</summary>
    public ServiceSetStartTypeOutput SetStartType(ServiceSetStartTypeParams p)
    {
        if (!ServiceRules.IsValidName(p.Name)) throw new OperationFailedException("invalid_params", "Not a service name.");
        if (p.StartType is not (ServiceStartType.Automatic or ServiceStartType.AutomaticDelayed or ServiceStartType.Manual or ServiceStartType.Disabled))
            throw new OperationFailedException("invalid_params", "A start type is automatic, automatic (delayed), manual or disabled.");
        if (ServiceRules.IsRefused(p.Name)) throw new OperationFailedException("execution_failed", $"The agent never changes {p.Name}.");
        string key = platform.KeyName(p.Name) ?? throw new OperationFailedException("not_found", "No service has that key name (display names are not accepted).");
        if (ServiceRules.IsRefused(key)) throw new OperationFailedException("execution_failed", $"The agent never changes {key}.");
        var facts = platform.Query(key) ?? throw new OperationFailedException("not_found", "No service has that name.");
        if (facts.StartType is ServiceStartType.Boot or ServiceStartType.System or ServiceStartType.Unknown)
            throw new OperationFailedException("execution_failed", "The start type of a driver or an unreadable service is never changed.");
        try { if (facts.StartType != p.StartType) platform.SetStartType(key, p.StartType); }
        catch (ServiceControlException e)
        {
            log($"Service {p.Name}: start type change failed (Windows error {e.Code}).");
            throw new OperationFailedException("execution_failed", $"Windows could not change the start type (error {e.Code}).");
        }
        var after = platform.Query(key)?.StartType ?? ServiceStartType.Unknown;
        log($"Service {p.Name}: start type {facts.StartType} -> {after}.");
        return new ServiceSetStartTypeOutput { Name = p.Name, Before = facts.StartType, After = after };
    }

    public ServiceControlOutput Run(ServiceControlParams p)
    {
        if (!ServiceRules.IsValidName(p.Name)) throw new OperationFailedException("invalid_params", "Not a service name.");
        if (ServiceRules.IsRefused(p.Name)) throw new OperationFailedException("execution_failed", $"The agent never changes {p.Name}.");
        string key = platform.KeyName(p.Name) ?? throw new OperationFailedException("not_found", "No service has that key name (display names are not accepted).");
        if (ServiceRules.IsRefused(key)) throw new OperationFailedException("execution_failed", $"The agent never changes {key}.");
        var facts = platform.Query(key) ?? throw new OperationFailedException("not_found", "No service has that name.");
        if (facts.StartType == ServiceStartType.Disabled && p.Action != ServiceAction.Stop)
            throw new OperationFailedException("execution_failed", "The service is disabled; the agent never changes a start type.");
        try
        {
            if (p.Action is ServiceAction.Stop or ServiceAction.Restart) platform.Stop(key);
            if (p.Action is ServiceAction.Start or ServiceAction.Restart) platform.Start(key);
        }
        catch (ServiceControlException e)
        {
            log($"Service {p.Name}: {p.Action} failed (Windows error {e.Code}).");
            throw new OperationFailedException("execution_failed", $"Windows could not {p.Action.ToString().ToLowerInvariant()} the service (error {e.Code}).");
        }
        var after = platform.Query(key)?.State ?? ServiceState.Unknown;
        log($"Service {p.Name}: {p.Action.ToString().ToLowerInvariant()} done; now {after}.");
        return new ServiceControlOutput { Name = p.Name, Action = p.Action, Before = facts.State, After = after };
    }
}
