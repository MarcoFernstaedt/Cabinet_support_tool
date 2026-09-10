using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Every Windows service, its state, how it starts, what it runs as and its pid.
/// </summary>
/// <remarks>
/// One <c>Win32_Service</c> query returns all of that at once.
/// <c>ServiceController</c> would need a separate round trip per service for the
/// account and the pid, which on a cabinet running several hundred services is
/// both slow and needlessly heavy on a machine doing clinical work.
/// </remarks>
public sealed class ServiceCollector : ICollector
{
    private readonly IWmiRepository _wmi;

    public ServiceCollector(IWmiRepository wmi) => _wmi = wmi;

    public string SectionName => CollectorSections.Services;

    public Task CollectAsync(CheckInDraft draft, CancellationToken cancellationToken)
    {
        var rows = _wmi.Query(
            WmiScopes.CimV2,
            "SELECT Name, DisplayName, State, StartMode, StartName, ProcessId, DelayedAutoStart " +
            "FROM Win32_Service");

        var services = new List<ServiceInfo>(rows.Count);

        foreach (var row in rows)
        {
            var name = row.GetString("Name");
            if (name is null)
            {
                continue;
            }

            var processId = row.GetInt32("ProcessId");

            services.Add(new ServiceInfo
            {
                Name = name,
                DisplayName = row.GetString("DisplayName"),
                State = ParseState(row.GetString("State")),
                StartType = ParseStartType(row.GetString("StartMode"), row.GetBoolean("DelayedAutoStart")),
                RunAsAccount = row.GetString("StartName"),

                // A stopped service reports pid 0, which is not a process.
                ProcessId = processId is > 0 ? processId : null,
            });
        }

        draft.Services = services
            .OrderBy(service => service.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return Task.CompletedTask;
    }

    internal static ServiceState ParseState(string? state) => state?.Trim() switch
    {
        "Stopped" => ServiceState.Stopped,
        "Start Pending" => ServiceState.StartPending,
        "Stop Pending" => ServiceState.StopPending,
        "Running" => ServiceState.Running,
        "Continue Pending" => ServiceState.ContinuePending,
        "Pause Pending" => ServiceState.PausePending,
        "Paused" => ServiceState.Paused,
        _ => ServiceState.Unknown,
    };

    /// <summary>
    /// Maps WMI's StartMode to the contract's start type.
    /// </summary>
    /// <remarks>
    /// WMI reports both automatic and delayed-automatic services as "Auto"; the
    /// distinction lives in a separate property. Collapsing them would make a
    /// delayed service that has not started yet look like one that failed to.
    /// </remarks>
    internal static ServiceStartType ParseStartType(string? startMode, bool? delayedAutoStart)
        => startMode?.Trim() switch
        {
            "Boot" => ServiceStartType.Boot,
            "System" => ServiceStartType.System,
            "Auto" => delayedAutoStart == true
                ? ServiceStartType.AutomaticDelayed
                : ServiceStartType.Automatic,
            "Manual" => ServiceStartType.Manual,
            "Disabled" => ServiceStartType.Disabled,
            _ => ServiceStartType.Unknown,
        };
}
