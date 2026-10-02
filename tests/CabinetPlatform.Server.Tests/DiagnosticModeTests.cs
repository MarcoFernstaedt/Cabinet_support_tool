using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Server.Tests;

public class DiagnosticModeTests
{
    [Theory]
    [InlineData("DiagnosticOnly", false)]
#if LEGACY_MAINTENANCE_TESTS
    [InlineData("Maintenance", true)]
    [InlineData("Demo", true)]
#else
    [InlineData("Maintenance", false)]
    [InlineData("Demo", false)]
#endif
    [InlineData("demo", false)]
    [InlineData("maintenance", false)]
    [InlineData("", false)]
    [InlineData("unexpected", false)]
    public void Only_explicit_modes_enable_selected_termination(string mode, bool maintenance)
    {
        var options = new CabinetPlatform.Server.Configuration.ActionOptions { ExecutionMode = mode };
        Assert.Equal("DiagnosticOnly", new CabinetPlatform.Server.Configuration.ActionOptions().ExecutionMode);
        Assert.Equal(maintenance, options.Permits(ActionName.KillProcess));
#if LEGACY_MAINTENANCE_TESTS
        Assert.Equal(mode == "Maintenance", options.MaintenanceEnabled);
        Assert.Equal(mode == "Maintenance", options.Permits(ActionName.RestartApplication));
#else
        Assert.False(options.MaintenanceEnabled);
        Assert.False(options.Permits(ActionName.RestartApplication));
#endif
        Assert.True(options.Permits(ActionName.GetProcessList));
        Assert.False(options.Permits((ActionName)9999));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Demo")]
    public async Task Restricted_dispatch_cancels_stale_mutation_but_dispatches_observation(string? mode)
    {
        using var factory = new SupportApiFactory { ExecutionMode = mode };
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "stale");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "stale", user.Id);
        var actions = Enum.GetValues<ActionName>().Append((ActionName)9999)
            .Except(new[] { ActionName.CollectEventLogs, ActionName.RunEventLogView, ActionName.GetScheduledUpdates, ActionName.InspectFirewall });
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
        var dispatched = new List<ActionRequestDto>();
        // The endpoint deliberately takes at most twenty queue rows per poll.
        for (int poll = 0; poll < actions.Count(); poll++)
            dispatched.AddRange((await agent.GetFromJsonAsync<List<ActionRequestDto>>("/api/agent/actions", TestClient.Json))!);
        Assert.Contains(dispatched, r => r.Action == ActionName.GetProcessList);
        Assert.Contains(dispatched, r => r.Action == ActionName.GetDisplayDiagnostics);
        Assert.Equal(2, dispatched.Count);
        await factory.WithDbAsync(async db =>
        {
            var rows = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync(db.ActionRequests);
            Assert.All(rows.Where(r => r.Action is not (ActionName.GetProcessList or ActionName.GetDisplayDiagnostics)),
                r => Assert.Equal(ActionRequestStatus.Cancelled, r.Status));
        });
    }

    [Fact]
    public async Task Demo_rejects_approval_of_queued_legacy_mutations()
    {
        using var factory = new SupportApiFactory { ExecutionMode = "Demo" };
        var (_, requester) = await TestClient.CreateUserClientAsync(factory, Role.Tier2, "old-requester");
        var (approver, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "demo-approver");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "approval", requester.Id);
        var allowed = new[] { ActionName.GetProcessList, ActionName.CollectEventLogs,
            ActionName.RunEventLogView, ActionName.GetScheduledUpdates, ActionName.InspectFirewall,
            ActionName.GetDisplayDiagnostics, ActionName.KillProcess };
        foreach (var action in Enum.GetValues<ActionName>().Append((ActionName)9999).Except(allowed))
        {
            var id = Guid.NewGuid();
            await factory.WithDbAsync(async db =>
            {
                db.ActionRequests.Add(new CabinetPlatform.Server.Domain.ActionRequest
                {
                    Id = id, CabinetId = cabinet.Id, Action = action, RequestedByUserId = requester.Id,
                    Reason = "Legacy pending request", ParametersJson = "{}",
                    Status = ActionRequestStatus.PendingApproval, RequestedUtc = DateTimeOffset.UtcNow,
                });
                await db.SaveChangesAsync();
            });
            using var response = await approver.PostAsJsonAsync($"/api/actions/{id}/approve", new ApproveActionRequest());
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            await factory.WithDbAsync(async db =>
                Assert.Equal(ActionRequestStatus.PendingApproval, (await db.ActionRequests.FindAsync(id))!.Status));
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Demo")]
    public async Task Restricted_catalog_and_request_path_allow_only_reviewed_actions(string? mode)
    {
        using var factory = new SupportApiFactory { ExecutionMode = mode };
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "diagnostic");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "diagnostic", user.Id);
        var allowed = new[] { ActionName.GetProcessList, ActionName.CollectEventLogs,
            ActionName.RunEventLogView, ActionName.GetScheduledUpdates, ActionName.InspectFirewall,
            ActionName.GetDisplayDiagnostics };
        var catalog = await client.GetFromJsonAsync<List<ActionCatalogEntryDto>>("/api/actions/catalog", TestClient.Json);
#if LEGACY_MAINTENANCE_TESTS
        Assert.Equal((mode == "Demo" ? allowed.Append(ActionName.KillProcess) : allowed).Order(),
#else
        Assert.Equal(allowed.Order(),
#endif
            catalog!.Select(x => x.Action).Order());
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
