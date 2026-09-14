using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Server.Tests;

public class DiagnosticModeTests
{
    [Theory]
    [InlineData("DiagnosticOnly", false)]
    [InlineData("Maintenance", true)]
    [InlineData("maintenance", false)]
    [InlineData("", false)]
    [InlineData("unexpected", false)]
    public void Only_explicit_maintenance_configuration_enables_mutations(string mode, bool maintenance)
    {
        var options = new CabinetPlatform.Server.Configuration.ActionOptions { ExecutionMode = mode };
        Assert.Equal("DiagnosticOnly", new CabinetPlatform.Server.Configuration.ActionOptions().ExecutionMode);
        Assert.Equal(maintenance, options.Permits(ActionName.KillProcess));
        Assert.True(options.Permits(ActionName.GetProcessList));
        Assert.False(options.Permits((ActionName)9999));
    }

    [Fact]
    public async Task Default_dispatch_cancels_stale_mutation_but_dispatches_observation()
    {
        using var factory = new SupportApiFactory { ExecutionMode = null };
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "stale");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "stale", user.Id);
        var actions = new[] { ActionName.KillProcess, ActionName.GetProcessList, (ActionName)9999 };
        await factory.WithDbAsync(async db =>
        {
            foreach (var action in actions)
                db.ActionRequests.Add(new CabinetPlatform.Server.Domain.ActionRequest
                {
                    CabinetId = cabinet.Id, Action = action, RequestedByUserId = user.Id,
                    Reason = "Previously approved request", ParametersJson = "{}",
                    Status = ActionRequestStatus.Approved, RequestedUtc = DateTimeOffset.UtcNow,
                    ExpiresUtc = DateTimeOffset.UtcNow.AddMinutes(10)
                });
            await db.SaveChangesAsync();
        });
        using var agent = TestClient.CreateAgentClient(factory, cabinet.MachineId);
        var dispatched = await agent.GetFromJsonAsync<List<ActionRequestDto>>("/api/agent/actions", TestClient.Json);
        Assert.Equal(ActionName.GetProcessList, Assert.Single(dispatched!).Action);
        await factory.WithDbAsync(async db =>
        {
            var rows = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync(db.ActionRequests);
            Assert.All(rows.Where(r => r.Action != ActionName.GetProcessList),
                r => Assert.Equal(ActionRequestStatus.Cancelled, r.Status));
        });
    }

    [Fact]
    public async Task Default_catalog_and_request_path_allow_only_reviewed_observations()
    {
        using var factory = new SupportApiFactory { ExecutionMode = null };
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "diagnostic");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "diagnostic", user.Id);
        var allowed = new[] { ActionName.GetProcessList, ActionName.CollectEventLogs,
            ActionName.RunEventLogView, ActionName.GetScheduledUpdates };
        var catalog = await client.GetFromJsonAsync<List<ActionCatalogEntryDto>>("/api/actions/catalog", TestClient.Json);
        Assert.Equal(allowed.Order(), catalog!.Select(x => x.Action).Order());
        foreach (var action in Enum.GetValues<ActionName>().Append((ActionName)9999).Except(allowed))
        {
            var response = await client.PostAsJsonAsync("/api/actions", new CreateActionRequest
            {
                Action = action, CabinetId = cabinet.Id, Reason = "Diagnostic mode policy test",
                OverrideSafetyChecks = true, OverrideReason = "Supervisor cannot bypass mode"
            });
            Assert.False(response.IsSuccessStatusCode, action.ToString());
        }
        foreach (var action in allowed.Except(new[] { ActionName.RunEventLogView }))
        {
            var response = await client.PostAsJsonAsync("/api/actions", new CreateActionRequest
            { Action = action, CabinetId = cabinet.Id, Reason = "Read diagnostic information" });
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        }
    }
}
