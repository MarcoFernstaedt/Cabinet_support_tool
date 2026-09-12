using System.Runtime.Versioning;
using System.ServiceProcess;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Controls Windows services. Abstracted so the executors' allow-list and
/// state-transition logic can be tested without touching a real service.
/// </summary>
public interface IServiceControlGateway
{
    /// <summary>Reads a service's current run state.</summary>
    /// <param name="serviceName">The service.</param>
    ServiceState GetState(string serviceName);

    /// <summary>Starts a service and waits for it to be running.</summary>
    /// <param name="serviceName">The service.</param>
    /// <param name="timeout">How long to wait.</param>
    void Start(string serviceName, TimeSpan timeout);

    /// <summary>Stops a service and waits for it to be stopped.</summary>
    /// <param name="serviceName">The service.</param>
    /// <param name="timeout">How long to wait.</param>
    void Stop(string serviceName, TimeSpan timeout);

    /// <summary>Reads a service's configured start type.</summary>
    /// <param name="serviceName">The service.</param>
    ServiceStartType GetStartType(string serviceName);

    /// <summary>
    /// Changes a service's configured start type.
    /// </summary>
    /// <remarks>
    /// Through the service control manager, via
    /// <c>Win32_Service.ChangeStartMode</c>, rather than by writing the
    /// registry directly. The manager then sees the change and applies its own
    /// rules, and — more to the point — the agent keeps no mechanism for
    /// editing arbitrary registry values, which is a capability that would be
    /// far harder to bound than this one.
    /// </remarks>
    /// <param name="serviceName">The service.</param>
    /// <param name="startType">The new start type.</param>
    void SetStartType(string serviceName, ServiceStartType startType);
}

/// <summary>
/// Drives the service control manager through <see cref="ServiceController"/>.
/// </summary>
/// <remarks>
/// Bulk reads go through WMI instead; this type exists for the handful of
/// state changes, where <see cref="ServiceController"/>'s wait-for-status is
/// what the executors need.
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class ServiceControlGateway : IServiceControlGateway
{
    private readonly Wmi.IWmiRepository _wmi;

    /// <summary>Creates the gateway.</summary>
    /// <param name="wmi">
    /// Used for the one operation <see cref="ServiceController"/> does not
    /// expose: changing a start mode.
    /// </param>
    public ServiceControlGateway(Wmi.IWmiRepository wmi) => _wmi = wmi;

    /// <inheritdoc />
    public ServiceState GetState(string serviceName)
    {
        using var controller = new ServiceController(serviceName);
        return Map(controller.Status);
    }

    public void Start(string serviceName, TimeSpan timeout)
    {
        using var controller = new ServiceController(serviceName);

        // Already running is the requested end state, so it is a success and
        // not an error to report.
        if (controller.Status is ServiceControllerStatus.Running or ServiceControllerStatus.StartPending)
        {
            controller.WaitForStatus(ServiceControllerStatus.Running, timeout);
            return;
        }

        controller.Start();
        controller.WaitForStatus(ServiceControllerStatus.Running, timeout);
    }

    public void Stop(string serviceName, TimeSpan timeout)
    {
        using var controller = new ServiceController(serviceName);

        if (controller.Status is ServiceControllerStatus.Stopped or ServiceControllerStatus.StopPending)
        {
            controller.WaitForStatus(ServiceControllerStatus.Stopped, timeout);
            return;
        }

        if (!controller.CanStop)
        {
            throw new InvalidOperationException(
                $"The service '{serviceName}' reports that it cannot be stopped.");
        }

        controller.Stop();
        controller.WaitForStatus(ServiceControllerStatus.Stopped, timeout);
    }

    /// <inheritdoc />
    public ServiceStartType GetStartType(string serviceName)
    {
        using var controller = new ServiceController(serviceName);

        return MapStartType(controller.StartType);
    }

    /// <inheritdoc />
    public void SetStartType(string serviceName, ServiceStartType startType)
    {
        // The string Win32_Service.ChangeStartMode expects. Delayed auto-start
        // is "Automatic" here as well: the delayed flag is a separate value the
        // service control manager keeps, and this gateway deliberately does not
        // reach past the manager to write it.
        string mode = startType switch
        {
            ServiceStartType.Automatic or ServiceStartType.AutomaticDelayed => "Automatic",
            ServiceStartType.Manual => "Manual",
            ServiceStartType.Disabled => "Disabled",

            // Boot and System are driver load orders. Setting an ordinary
            // service to one does not make it start earlier; it makes the
            // machine fail to boot, which is why neither reaches this far — the
            // server refuses them and so does the executor.
            _ => throw new ArgumentOutOfRangeException(
                nameof(startType),
                startType,
                "Only Automatic, AutomaticDelayed, Manual and Disabled may be set."),
        };

        // The name is quoted into a WQL filter, so it is checked once more
        // here against the shape a Windows service name may take. It has
        // already passed the server's allow-list and the agent's own; this is
        // the last point at which a value carrying a quote could matter, and
        // the cost of checking again is nothing.
        if (!IsSimpleServiceName(serviceName))
        {
            throw new ArgumentException(
                "The service name is not a valid Windows service name.", nameof(serviceName));
        }

        IReadOnlyList<Wmi.WmiMethodResult> results = _wmi.InvokeMethod(
            Wmi.WmiScopes.CimV2,
            $"SELECT * FROM Win32_Service WHERE Name = '{serviceName}'",
            "ChangeStartMode",
            new Dictionary<string, object?> { ["StartMode"] = mode });

        if (results.Count == 0)
        {
            throw new InvalidOperationException(
                $"No service named '{serviceName}' is installed on this machine.");
        }

        Wmi.WmiMethodResult result = results[0];

        if (!result.Succeeded)
        {
            throw new InvalidOperationException(
                $"The service control manager refused to set '{serviceName}' to {mode} " +
                $"(return code {result.ReturnValue}).");
        }
    }

    private static bool IsSimpleServiceName(string serviceName) =>
        !string.IsNullOrWhiteSpace(serviceName) &&
        serviceName.Length <= 256 &&
        serviceName.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '-');

    internal static ServiceStartType MapStartType(ServiceStartMode mode) => mode switch
    {
        ServiceStartMode.Boot => ServiceStartType.Boot,
        ServiceStartMode.System => ServiceStartType.System,

        // ServiceController cannot tell delayed auto-start from ordinary
        // auto-start; both report Automatic. Reported as Automatic rather than
        // guessed at, because a wrong answer would show a rep a start type the
        // machine does not have.
        ServiceStartMode.Automatic => ServiceStartType.Automatic,
        ServiceStartMode.Manual => ServiceStartType.Manual,
        ServiceStartMode.Disabled => ServiceStartType.Disabled,
        _ => ServiceStartType.Unknown,
    };

    internal static ServiceState Map(ServiceControllerStatus status) => status switch
    {
        ServiceControllerStatus.Stopped => ServiceState.Stopped,
        ServiceControllerStatus.StartPending => ServiceState.StartPending,
        ServiceControllerStatus.StopPending => ServiceState.StopPending,
        ServiceControllerStatus.Running => ServiceState.Running,
        ServiceControllerStatus.ContinuePending => ServiceState.ContinuePending,
        ServiceControllerStatus.PausePending => ServiceState.PausePending,
        ServiceControllerStatus.Paused => ServiceState.Paused,
        _ => ServiceState.Unknown,
    };
}
