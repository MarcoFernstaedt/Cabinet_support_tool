using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Server.Actions;

namespace CabinetPlatform.Agent.Tests;

public sealed class FirewallInspectionTests
{
    [Fact]
    public void Native_gateway_and_read_executor_are_registered_in_shipping_composition()
    {
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        CabinetPlatform.Agent.AgentServiceRegistration.AddCabinetAgent(services,
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build());
        Assert.Contains(services, s => s.ServiceType == typeof(CabinetPlatform.Agent.Platform.IFirewallGateway)
            && s.ImplementationType == typeof(CabinetPlatform.Agent.Platform.WindowsFirewallGateway));
        Assert.Contains(services, s => s.ServiceType == typeof(CabinetPlatform.Agent.Actions.IActionExecutor)
            && s.ImplementationType == typeof(CabinetPlatform.Agent.Actions.Executors.InspectFirewallExecutor));
    }

    [Fact]
    public void Firewall_inspection_is_an_explicit_read_only_parameterless_release_action()
    {
        var inspection = (ActionName)29;
        Assert.True(MonitoringBoundary.IsObservation(inspection));
        Assert.True(ActionCatalog.TryGet(inspection, out var entry));
        Assert.False(entry.IsDisruptive);
        Assert.False(entry.RequiresApproval);
        Assert.Empty(entry.AllowedParameterKeys);
        Assert.False(entry.Batchable);
    }
}
