using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class WerMetadataEndpointTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory factory;
    public WerMetadataEndpointTests(SupportApiFactory factory) => this.factory = factory;
    private static string Latest(Guid cabinet) => $"/api/cabinets/{cabinet}/wer-metadata/latest";
    private static string Pinned(Guid cabinet, Guid action) => $"/api/cabinets/{cabinet}/wer-metadata/{action}";

    private async Task<(HttpClient User, HttpClient Agent, Cabinet Cabinet, ActionRequest Action)> SetupAsync(ActionRequestStatus status = ActionRequestStatus.Dispatched)
    {
        (HttpClient userClient, User user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString("N"));
        string machine = Guid.NewGuid().ToString("N");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(factory, machine, user.Id, clientName: Guid.NewGuid().ToString("N"));
        var action = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = user.Id,
            RequestedUtc = DateTimeOffset.UtcNow, Action = ActionName.GetWerMetadata,
            Status = status, ParametersJson = "{}", Reason = "Synthetic WER test" };
        await factory.WithDbAsync(async db => { db.ActionRequests.Add(action); await db.SaveChangesAsync(); });
        return (userClient, TestClient.CreateAgentClient(factory, machine), cabinet, action);
    }

    private static string Wire(DateTimeOffset? observed = null, int count = 1)
    {
        DateTimeOffset now = observed ?? DateTimeOffset.UtcNow.AddMinutes(-1);
        return JsonSerializer.Serialize(new WerMetadataResult
        {
            ObservedUtc = now,
            Stores = [new() { Store = WerStore.MachineQueue, Status = WerStoreStatus.Read },
                new() { Store = WerStore.MachineArchive, Status = WerStoreStatus.Denied }],
            Reports = Enumerable.Range(0, count).Select(_ => new WerReportObservation
            {
                ReportId = Guid.NewGuid(), CreatedUtc = now.AddMinutes(-1), Store = WerStore.MachineQueue,
                EventType = "APPCRASH"
            }).ToArray()
        }, ContractJson.Default);
    }

    private static Task<HttpResponseMessage> Report(HttpClient agent, Guid action, string? data,
        ActionStatus status = ActionStatus.Succeeded, string? output = "private output") =>
        agent.PostJsonAsync("/api/agent/actions/result", new ActionResultDto { RequestId = action, Status = status,
            StartedAtUtc = DateTimeOffset.UtcNow, CompletedAtUtc = DateTimeOffset.UtcNow,
            CollectedData = data, Output = output });

    [Fact]
    public async Task Authenticated_request_is_parameterless_and_dispatches_only_to_own_cabinet()
    {
        (HttpClient user, User staff) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString("N"));
        string machine = Guid.NewGuid().ToString("N");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(factory, machine, staff.Id, clientName: Guid.NewGuid().ToString("N"));
        HttpResponseMessage denied = await user.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            CabinetId = cabinet.Id, Action = ActionName.GetWerMetadata, Reason = "Observe crash metadata",
            Parameters = new Dictionary<string, string> { ["path"] = "private" }
        });
        Assert.Equal(HttpStatusCode.BadRequest, denied.StatusCode);
        HttpResponseMessage created = await user.PostJsonAsync("/api/actions", new CreateActionRequest
        { CabinetId = cabinet.Id, Action = ActionName.GetWerMetadata, Reason = "Observe crash metadata" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        ActionRequestView dto = (await created.ReadAsync<ActionRequestView>())!;
        Assert.Equal(ActionRequestStatus.Approved, dto.Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync(Latest(cabinet.Id))).StatusCode);
        using JsonDocument dispatch = JsonDocument.Parse(await TestClient.CreateAgentClient(factory, machine).GetStringAsync("/api/agent/actions"));
        Assert.Contains(dispatch.RootElement.EnumerateArray(), row => row.GetProperty("id").GetGuid() == dto.Id);
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(Guid.NewGuid(), dto.Id))).StatusCode);
    }

    [Fact]
    public async Task Invalid_wire_is_rejected_without_mutating_action_or_leaking_audit()
    {
        string good = Wire();
        string reportId = JsonDocument.Parse(good).RootElement.GetProperty("reports")[0].GetProperty("reportId").GetString()!;
        string[] bad = [
            "null", "{}", good + new string(' ', 8192),
            good.Replace("\"version\":1", "\"version\":2"),
            good.Replace("\"version\":1", "\"version\":1,\"secret\":\"patient\""),
            good.Replace("\"version\":1", "\"version\":1,\"version\":1"),
            good.Replace("\"eventType\":\"APPCRASH\"", "\"eventType\":\"UNKNOWN\""),
            good.Replace("\"eventType\":\"APPCRASH\"", "\"eventType\":\"APPCRASH\",\"signature\":\"patient\""),
            good.Replace("\"eventType\":\"APPCRASH\"", "\"eventType\":\"APPCRASH\",\"eventType\":\"BEX\""),
            good.Replace("\"status\":\"Read\"", "\"status\":\"Unknown\""),
            good.Replace("\"status\":\"Read\"", "\"status\":99"),
            good.Replace("\"store\":\"MachineQueue\"", "\"store\":\"MachineArchive\""),
            good.Replace("\"status\":\"Denied\"", "\"status\":\"Read\",\"note\":\"patient\""),
            good.Replace("\"status\":\"Read\"", "\"status\":\"Denied\""),
            good.Replace("\"truncated\":false", "\"truncated\":true"),
            good.Replace("\"reportId\":\"" + reportId + "\"", "\"reportId\":\"00000000-0000-0000-0000-000000000000\""),
            good.Replace("\"observedUtc\":", "\"observedUtc\":\"2040-01-01T00:00:00Z\",\"oldObservedUtc\":"),
            good.Replace("\"createdUtc\":", "\"createdUtc\":\"2040-01-01T00:00:00Z\",\"oldCreatedUtc\":"),
            good.Replace("\"eventType\":\"APPCRASH\"", "\"eventType\":null"),
            good.Replace("\"reports\":[", "\"reports\":null,\"other\":[")
        ];
        foreach (string wire in bad)
        {
            var (_, agent, cabinet, action) = await SetupAsync();
            Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, wire, output: "private output patient")).StatusCode);
            ActionRequest stored = await factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
            Assert.Equal(ActionRequestStatus.Dispatched, stored.Status);
            Assert.Null(stored.CollectedDataJson);
            Assert.Null(stored.ResultOutput);
            var audits = await factory.WithDbAsync(db => db.AuditEntries.AsNoTracking()
                .Where(a => a.CabinetId == cabinet.Id && a.Action == ActionName.GetWerMetadata).ToListAsync());
            Assert.Contains(audits, a => a.Event == AuditEvent.AgentReportResult && a.Result == AuditResult.Denied);
            Assert.DoesNotContain(audits, a => a.Details?.Contains("patient", StringComparison.Ordinal) == true);
        }
    }

    [Fact]
    public async Task Capacity_times_and_failure_state_are_bounded()
    {
        var (user, agent, cabinet, action) = await SetupAsync();
        Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, Wire(count: 41))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, Wire(DateTimeOffset.UtcNow.AddDays(-8)))).StatusCode);
        string tooOld = Wire().Replace("\"createdUtc\":", "\"createdUtc\":\"2020-01-01T00:00:00Z\",\"other\":");
        Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, tooOld)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, Wire(count: 40))).StatusCode);
        using JsonDocument accepted = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        Assert.Equal(40, accepted.RootElement.GetProperty("metadata").GetProperty("reports").GetArrayLength());
        var (_, failedAgent, failedCabinet, failedAction) = await SetupAsync();
        Assert.Equal(HttpStatusCode.BadRequest, (await Report(failedAgent, failedAction.Id, Wire(), ActionStatus.Failed)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await Report(failedAgent, failedAction.Id, null, ActionStatus.Failed)).StatusCode);
        ActionRequest saved = await factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == failedAction.Id));
        Assert.Null(saved.ResultOutput);
        using JsonDocument failed = JsonDocument.Parse(await user.GetStringAsync(Pinned(failedCabinet.Id, failedAction.Id)));
        Assert.Equal("failed", failed.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, failed.RootElement.GetProperty("metadata").ValueKind);
    }

    [Fact]
    public async Task Duplicate_report_ids_and_impossible_time_or_store_coverage_are_rejected()
    {
        string good = Wire();
        using JsonDocument parsed = JsonDocument.Parse(good);
        string row = parsed.RootElement.GetProperty("reports")[0].GetRawText();
        string observed = parsed.RootElement.GetProperty("observedUtc").GetString()!;
        string[] invalid = [
            good.Replace("\"reports\":[" + row + "]", "\"reports\":[" + row + "," + row + "]"),
            good.Replace("\"createdUtc\":", "\"createdUtc\":\"2020-01-01T00:00:00Z\",\"createdUtcOriginal\":"),
            good.Replace("\"createdUtc\":", "\"createdUtc\":\"2040-01-01T00:00:00Z\",\"createdUtcOriginal\":"),
            good.Replace("\"createdUtc\":", "\"createdUtc\":\"" + DateTimeOffset.Parse(observed).AddDays(-8).ToString("O") + "\",\"createdUtcOriginal\":"),
            good.Replace(row, row.Replace("\"store\":\"MachineQueue\"", "\"store\":\"MachineArchive\""))
        ];
        foreach (string wire in invalid)
        {
            var (_, agent, _, action) = await SetupAsync();
            Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, wire)).StatusCode);
        }
    }

    [Fact]
    public async Task Latest_and_pinned_are_distinct_and_corrupt_saved_data_never_projects()
    {
        var (user, agent, cabinet, old) = await SetupAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, old.Id, Wire())).StatusCode);
        var newer = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = old.RequestedByUserId,
            RequestedUtc = old.RequestedUtc.AddMinutes(1), Action = ActionName.GetWerMetadata,
            Status = ActionRequestStatus.Dispatched, ParametersJson = "{}", Reason = "Next observation" };
        await factory.WithDbAsync(async db => { db.ActionRequests.Add(newer); await db.SaveChangesAsync(); });
        using JsonDocument latest = JsonDocument.Parse(await user.GetStringAsync(Latest(cabinet.Id)));
        Assert.Equal(newer.Id, latest.RootElement.GetProperty("actionId").GetGuid());
        Assert.Equal("pending", latest.RootElement.GetProperty("state").GetString());
        using JsonDocument pinned = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, old.Id)));
        Assert.Equal(old.Id, pinned.RootElement.GetProperty("actionId").GetGuid());
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(Guid.NewGuid(), old.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(cabinet.Id, Guid.NewGuid()))).StatusCode);
        await factory.WithDbAsync(async db => { ActionRequest action = await db.ActionRequests.SingleAsync(a => a.Id == old.Id);
            action.CollectedDataJson = "{\"private\":\"patient\"}"; await db.SaveChangesAsync(); });
        HttpResponseMessage invalid = await user.GetAsync(Pinned(cabinet.Id, old.Id));
        Assert.Equal(HttpStatusCode.BadGateway, invalid.StatusCode);
        Assert.DoesNotContain("patient", await invalid.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        var audits = await factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().Where(a => a.CabinetId == cabinet.Id && a.Action == ActionName.GetWerMetadata).ToListAsync());
        Assert.Contains(audits, a => a.Event == AuditEvent.ListActions && a.Result == AuditResult.Denied);
        Assert.DoesNotContain(audits, a => a.Details?.Contains("patient", StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task Revoked_staff_and_foreign_agent_cannot_read_or_complete_pinned_action()
    {
        var (user, _, cabinet, action) = await SetupAsync();
        string foreignMachine = Guid.NewGuid().ToString("N");
        await TestClient.CreateApprovedCabinetAsync(factory, foreignMachine, action.RequestedByUserId,
            clientName: Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.NotFound, (await Report(TestClient.CreateAgentClient(factory, foreignMachine), action.Id, Wire())).StatusCode);
        ActionRequest untouched = await factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
        Assert.Equal(ActionRequestStatus.Dispatched, untouched.Status);
        Assert.Null(untouched.CollectedDataJson);
        await factory.WithDbAsync(async db => { User staff = await db.Users.SingleAsync(u => u.Id == action.RequestedByUserId);
            staff.SecurityStamp = Guid.NewGuid(); await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.GetAsync(Latest(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.GetAsync(Pinned(cabinet.Id, action.Id))).StatusCode);
    }

    [Fact]
    public async Task Parameterless_request_dispatch_report_and_pinned_typed_read()
    {
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.GetWerMetadata);
        Assert.Empty(entry.AllowedParameterKeys);
        Assert.False(entry.RequiresApproval);
        Assert.False(entry.IsDisruptive);
        Assert.False(entry.Batchable);
        var (user, agent, cabinet, action) = await SetupAsync(ActionRequestStatus.Approved);
        using JsonDocument dispatched = JsonDocument.Parse(await agent.GetStringAsync("/api/agent/actions"));
        Assert.Equal(action.Id, dispatched.RootElement[0].GetProperty("id").GetGuid());
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, Wire())).StatusCode);
        ActionRequest stored = await factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
        Assert.Null(stored.ResultOutput);
        ActionRequestView generic = (await (await user.GetAsync($"/api/actions/{action.Id}")).ReadAsync<ActionRequestView>())!;
        Assert.Null(generic.CollectedData);
        Assert.Null(generic.ResultOutput);
        using JsonDocument response = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        JsonElement root = response.RootElement;
        Assert.Equal(new[] { "cabinetId", "actionId", "state", "requestedAtUtc", "completedAtUtc", "metadata" }, root.EnumerateObject().Select(p => p.Name));
        Assert.Equal("complete", root.GetProperty("state").GetString());
        Assert.Equal(new[] { "version", "observedUtc", "stores", "reports" }, root.GetProperty("metadata").EnumerateObject().Select(p => p.Name));
        Assert.Single(root.GetProperty("metadata").GetProperty("reports").EnumerateArray());
        Assert.Equal(action.Id, root.GetProperty("actionId").GetGuid());
    }
}
