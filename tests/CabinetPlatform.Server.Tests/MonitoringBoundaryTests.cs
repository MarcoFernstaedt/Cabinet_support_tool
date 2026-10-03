using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Actions;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

// Run against the shipped composition, never the historical maintenance test build.
#if !LEGACY_MAINTENANCE_TESTS
public class MonitoringBoundaryTests
{
    private static readonly ActionName[] Observations =
    [ActionName.GetProcessList, ActionName.CollectEventLogs, ActionName.RunEventLogView, ActionName.GetScheduledUpdates, ActionName.InspectFirewall, ActionName.GetDisplayDiagnostics, ActionName.GetWerMetadata, ActionName.GetHistoricalProcessEvidence];

    [Theory]
    [InlineData("Demo")]
    [InlineData("Maintenance")]
    [InlineData("DiagnosticOnly")]
    [InlineData("unexpected")]
    public async Task Legacy_configuration_cannot_restore_requests_batches_approvals_or_persisted_dispatch(string mode)
    {
        using var factory = new SupportApiFactory { ExecutionMode = mode };
        var (client, requester) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "monitor");
        var (approver, approverUser) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "approver");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "monitor", requester.Id);
        var catalog = await client.GetFromJsonAsync<List<ActionCatalogEntryDto>>("/api/actions/catalog", TestClient.Json);
        Assert.Equal(Observations.Order(), catalog!.Select(e => e.Action).Order());
        var denied = Enum.GetValues<ActionName>().Append((ActionName)9999).Except(Observations).ToArray();
        foreach (var action in denied)
        {
            using var request = await client.PostAsJsonAsync("/api/actions", new CreateActionRequest
            {
                CabinetId = cabinet.Id, Action = action, Reason = "Monitoring boundary regression",
                OverrideSafetyChecks = true, OverrideReason = "Legacy supervisor override"
            });
            Assert.False(request.IsSuccessStatusCode, action.ToString());
            bool reserved = ActionCatalog.TryGet(action, out var entry) && entry.IsReservedHardwareActuation;
            Assert.Equal(action == ActionName.PingCabinet ? HttpStatusCode.Gone :
                reserved ? HttpStatusCode.Forbidden : HttpStatusCode.BadRequest, request.StatusCode);
            Assert.Contains(action == ActionName.PingCabinet ? "retired" :
                reserved ? "actuates cabinet hardware" : "Unknown action",
                await request.Content.ReadAsStringAsync());
            using var batch = await client.PostAsJsonAsync("/api/batches", new CreateBatchActionRequest
            { CabinetIds = [cabinet.Id], ConfirmedCabinetCount = 1, Action = action, Reason = "Monitoring boundary regression" });
            Assert.False(batch.IsSuccessStatusCode, action.ToString());
            Assert.NotEqual(HttpStatusCode.NotFound, batch.StatusCode);
            Assert.Contains("Unknown action", await batch.Content.ReadAsStringAsync());
            var batchId = Guid.NewGuid();
            await factory.WithDbAsync(async db =>
            {
                db.BatchActionRequests.Add(new CabinetPlatform.Server.Domain.BatchActionRequest
                {
                    Id = batchId, Action = action, RequestedByUserId = requester.Id,
                    RequestedUtc = DateTimeOffset.UtcNow, Reason = "Legacy pending batch", TargetCount = 1,
                    Status = BatchActionStatus.PendingApproval,
                    Targets = [new CabinetPlatform.Server.Domain.BatchActionTarget { CabinetId = cabinet.Id }]
                });
                await db.SaveChangesAsync();
            });
            using var batchApproval = await approver.PostAsJsonAsync($"/api/batches/{batchId}/approve", new ApproveActionRequest());
            Assert.Equal(HttpStatusCode.Conflict, batchApproval.StatusCode);
            Assert.Contains("no longer supported", await batchApproval.Content.ReadAsStringAsync());
            await factory.WithDbAsync(async db =>
            {
                Assert.Equal(BatchActionStatus.PendingApproval, (await db.BatchActionRequests.FindAsync(batchId))!.Status);
                Assert.False(await db.ActionRequests.AnyAsync(r => r.BatchId == batchId));
            });
            var id = Guid.NewGuid();
            await factory.WithDbAsync(async db =>
            {
                db.ActionRequests.Add(new CabinetPlatform.Server.Domain.ActionRequest
                {
                    Id = id, CabinetId = cabinet.Id, Action = action, RequestedByUserId = requester.Id,
                    Reason = "Persisted before upgrade", ParametersJson = "{}",
                    Status = ActionRequestStatus.PendingApproval, RequestedUtc = DateTimeOffset.UtcNow,
                    ExpiresUtc = DateTimeOffset.UtcNow.AddMinutes(10)
                });
                await db.SaveChangesAsync();
            });
            using var approval = await approver.PostAsJsonAsync($"/api/actions/{id}/approve", new ApproveActionRequest());
            Assert.Equal(HttpStatusCode.Conflict, approval.StatusCode);
            Assert.Contains("no longer supported", await approval.Content.ReadAsStringAsync());
            await factory.WithDbAsync(async db =>
            {
                var row = (await db.ActionRequests.FindAsync(id))!;
                Assert.Equal(ActionRequestStatus.PendingApproval, row.Status);
                // Simulate an approval committed by the previous maintenance release.
                row.Status = ActionRequestStatus.Approved;
                row.ApprovedByUserId = approverUser.Id;
                await db.SaveChangesAsync();
            });
        }
        using var observation = await client.PostAsJsonAsync("/api/actions", new CreateActionRequest
        { CabinetId = cabinet.Id, Action = ActionName.GetProcessList, Reason = "Observe only" });
        observation.EnsureSuccessStatusCode();
        using var agent = TestClient.CreateAgentClient(factory, cabinet.MachineId);
        var dispatched = new List<ActionRequestDto>();
        for (var poll = 0; poll <= denied.Length; poll++)
            dispatched.AddRange((await agent.GetFromJsonAsync<List<ActionRequestDto>>("/api/agent/actions", TestClient.Json))!);
        Assert.Equal(ActionName.GetProcessList, Assert.Single(dispatched).Action);
        await factory.WithDbAsync(async db =>
        {
            var rows = await db.ActionRequests.ToListAsync();
            Assert.Equal(denied.Length, rows.Count(r => r.Status == ActionRequestStatus.Cancelled));
            Assert.All(rows.Where(r => denied.Contains(r.Action)), r => Assert.Equal(ActionRequestStatus.Cancelled, r.Status));
        });
    }
}
#endif
