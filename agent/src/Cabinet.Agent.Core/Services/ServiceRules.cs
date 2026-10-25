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

    /// <summary>
    /// A start type that lets Windows (or an operator) start a service that could not be started before: automatic and
    /// automatic (delayed) start it at boot, and lifting Disabled makes a start possible at all. These are approved-list
    /// changes the same way a start is. Lowering a start type (to manual or disabled) starts nothing and is not.
    /// </summary>
    public static bool WouldLetStart(ServiceStartType before, ServiceStartType after) =>
        after is ServiceStartType.Automatic or ServiceStartType.AutomaticDelayed
        || (before == ServiceStartType.Disabled && after == ServiceStartType.Manual);

    /// <summary>
    /// The program a service's registered path points at, as Windows reports it now, or null when Windows will not say.
    /// The approved list names a program, so a service whose registered program cannot be read is never controlled.
    /// </summary>
    public static string? RegisteredProgram(IServicePlatform platform, string key, Action<string> log)
    {
        try
        {
            return platform.List().FirstOrDefault(s => string.Equals(s.Name, key, StringComparison.OrdinalIgnoreCase))?.ExecutablePath;
        }
        catch (Exception e)
        {
            log($"Service {key}: its registered program could not be read ({e.GetType().Name}).");
            return null;
        }
    }

    /// <summary>
    /// The program of a service's image path, without its arguments: <c>"C:\x\y.exe" -k foo</c> is <c>C:\x\y.exe</c>.
    /// An unquoted path ends at the first ".exe" that is followed by the end or by whitespace, never at the first ".exe"
    /// anywhere: <c>C:\a.exe.x.exe</c> is the program <c>C:\a.exe.x.exe</c>, not <c>C:\a.exe</c>, so a service pointed at
    /// a lookalike cannot borrow an approved program's path. A quote that is never closed is not a program (null), and the
    /// approved list refuses a program it cannot read.
    /// </summary>
    public static string? ProgramOnly(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        path = path.Trim();
        string program;
        if (path.StartsWith('"'))
        {
            int end = path.IndexOf('"', 1);
            if (end <= 1) return null;
            program = path[1..end];
        }
        else
        {
            program = path.Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries)[0];
            for (int at = path.IndexOf(".exe", StringComparison.OrdinalIgnoreCase); at > 0; at = path.IndexOf(".exe", at + 1, StringComparison.OrdinalIgnoreCase))
            {
                int after = at + 4;
                if (after == path.Length || char.IsWhiteSpace(path[after])) { program = path[..after]; break; }
            }
        }
        var kept = program.Where(c => c >= ' ' && c != '\u007f').ToArray();
        string clean = new string(kept).Trim();
        return clean.Length == 0 ? null : clean.Length <= 520 ? clean : clean[..520];
    }
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

    /// <summary>
    /// The approved list in force (milestone 10): the programs this cabinet may be asked to start, stop or restart. The
    /// broker sets it to the cabinet's own copy, read again for every request; left unset, nothing is approved and
    /// nothing is controlled.
    /// </summary>
    public Func<ApprovedApps> Approved { get; set; } = static () => ApprovedApps.None;

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
        // A start type that lets the service start (automatic, or lifting Disabled) is a start by another route, so it needs
        // the same approved-list entry service.control does; lowering a start type starts nothing and does not.
        if (facts.StartType != p.StartType && ServiceRules.WouldLetStart(facts.StartType, p.StartType))
            Approved().RefuseServiceControl(key, RegisteredProgram(key));
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
        // The approved list, checked against the program the service's registered path points at now: nothing that is not
        // on it is started, stopped or restarted, and a service whose program has been pointed elsewhere is not approved for.
        Approved().RefuseServiceControl(key, RegisteredProgram(key));
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

    private string? RegisteredProgram(string key) => ServiceRules.RegisteredProgram(platform, key, log);
}
