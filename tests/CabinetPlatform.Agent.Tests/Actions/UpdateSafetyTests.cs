using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

public class UpdateSafetyTests
{
    [Theory]
    [InlineData("occupied")]
    [InlineData("unreadable")]
    [InlineData("malformed")]
    public async Task ImmediateInstallDeniesUnsafeLiveOccupancy(string scenario)
    {
        var wmi = new FakeWmiRepository();
        if (scenario == "unreadable") wmi.Throws("Win32_LogonSession", new IOException("synthetic failure"));
        else wmi.Returns("Win32_LogonSession", FakeWmiRepository.Row(("LogonId", scenario == "malformed" ? null : "123"), ("LogonType", 2)));
        using var services = new ServiceCollection().AddSingleton(new LogonSessionReader(wmi)).BuildServiceProvider();
        var gateway = new StubUpdateGateway();
        var executor = ActivatorUtilities.CreateInstance<InstallUpdatesNowExecutor>(services,
            gateway, new InMemoryAgentStateStore(), new FixedClock(DateTimeOffset.UtcNow), NullLogger<InstallUpdatesNowExecutor>.Instance);
        var result = await executor.ExecuteAsync(Request(), CancellationToken.None);
        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Empty(gateway.Installed);
    }

    private static ActionRequestDto Request() => new()
    {
        Id = Guid.NewGuid(), Action = ActionName.InstallUpdatesNow, CabinetId = Guid.NewGuid(),
        RequestedByUserId = Guid.NewGuid(), RequestedUtc = DateTimeOffset.UtcNow, Reason = "synthetic test",
        Parameters = new Dictionary<string, string> { [ActionParameterKeys.UpdateIds] = "11111111-1111-4111-8111-111111111111" },
    };
}
