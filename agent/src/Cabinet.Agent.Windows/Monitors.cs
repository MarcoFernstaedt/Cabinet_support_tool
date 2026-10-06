using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Windows;

/// <summary>
/// Where the network service's monitors read from on Windows. Device Manager and the
/// firewall are read in the network process; the event logs and SMART data need the
/// broker, reached through the same read operations a command would use (and so the
/// same contract checks on what comes back).
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public static class WindowsMonitors
{
    public static MonitorSources Sources(AgentConfig config, BrokerClient broker)
    {
        var system = new SystemOperations(config);
        async Task<TOut> Broker<TOut>(string operation, object parameters, CancellationToken token)
        {
            JsonElement p = JsonSerializer.SerializeToElement(parameters, parameters.GetType(), ContractJson.Options);
            JsonElement output = await broker.RunAsync(operation, p, token).ConfigureAwait(false);
            return output.Deserialize<TOut>(ContractJson.Options)!;
        }
        return new MonitorSources
        {
            Devices = _ => Task.Run<IReadOnlyList<DeviceFacts>>(DeviceOperations.ReadDevices),
            Firewall = t => system.FirewallStateAsync(new EmptyParams(), t),
            Drives = t => Broker<DiskSmartOutput>(Catalog.DiskSmart, new EmptyParams(), t),
            Logs = async t => (await Broker<EventlogChannelsOutput>(Catalog.EventlogChannels, new EmptyParams(), t).ConfigureAwait(false))
                .Channels.Where(c => c.Available && c.Enabled).Select(c => c.Log).ToList(),
            Query = (p, t) => Broker<EventlogQueryOutput>(Catalog.EventlogQuery, p, t),
        };
    }
}
