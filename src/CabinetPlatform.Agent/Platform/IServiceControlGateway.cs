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
    ServiceState GetState(string serviceName);

    void Start(string serviceName, TimeSpan timeout);

    void Stop(string serviceName, TimeSpan timeout);
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
