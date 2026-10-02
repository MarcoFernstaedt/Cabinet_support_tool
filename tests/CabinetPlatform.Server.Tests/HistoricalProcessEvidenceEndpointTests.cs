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

public sealed class HistoricalProcessEvidenceEndpointTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory factory;
    public HistoricalProcessEvidenceEndpointTests(SupportApiFactory factory) => this.factory = factory;
    private static string Pinned(Guid cabinet, Guid action) => $"/api/cabinets/{cabinet}/historical-process-evidence/{action}";
    private static string Latest(Guid cabinet) => $"/api/cabinets/{cabinet}/historical-process-evidence/latest";
    private static string Wire(int count = 1, ProcessEvidenceStatus status = ProcessEvidenceStatus.Read, bool truncated = false)
    {
        DateTimeOffset observed = DateTimeOffset.UtcNow.AddMinutes(-1);
        return JsonSerializer.Serialize(new HistoricalProcessEvidenceResult { ObservedUtc = observed,
            WindowStartUtc = observed.AddDays(-1), Status = status, Truncated = truncated,
            Events = Enumerable.Range(0, count).Select(i => new HistoricalProcessEvent { OccurredUtc = observed.AddMinutes(-1),
                Kind = ProcessEventKind.Start, ProcessId = (uint)(i + 1), RecordId = i + 1 }).ToArray() }, ContractJson.Default);
    }

    private async Task<(HttpClient User, HttpClient Agent, Cabinet Cabinet, ActionRequest Action)> SetupAsync(ActionRequestStatus status = ActionRequestStatus.Dispatched)
    {
        (HttpClient user, User staff) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString("N"));
        string machine = Guid.NewGuid().ToString("N");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(factory, machine, staff.Id, clientName: Guid.NewGuid().ToString("N"));
        var action = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = staff.Id, RequestedUtc = DateTimeOffset.UtcNow,
            Action = ActionName.GetHistoricalProcessEvidence, Status = status, ParametersJson = "{}", Reason = "Synthetic history" };
        await factory.WithDbAsync(async db => { db.ActionRequests.Add(action); await db.SaveChangesAsync(); });
        return (user, TestClient.CreateAgentClient(factory, machine), cabinet, action);
    }
    private static Task<HttpResponseMessage> Report(HttpClient agent, Guid id, string? wire, ActionStatus status = ActionStatus.Succeeded) =>
        agent.PostJsonAsync("/api/agent/actions/result", new ActionResultDto { RequestId = id, Status = status,
            StartedAtUtc = DateTimeOffset.UtcNow, CompletedAtUtc = DateTimeOffset.UtcNow,
            CollectedData = wire, Output = "patient private output" });

    [Fact]
    public async Task Parameterless_request_dispatch_and_typed_pinned_read_suppress_generic_output()
    {
        ActionCatalogEntry catalog = ActionCatalog.Get(ActionName.GetHistoricalProcessEvidence);
        Assert.Empty(catalog.AllowedParameterKeys);
        Assert.False(catalog.RequiresApproval);
        Assert.False(catalog.IsDisruptive);
        Assert.False(catalog.Batchable);
        var (user, agent, cabinet, action) = await SetupAsync(ActionRequestStatus.Approved);
        HttpResponseMessage created = await user.PostJsonAsync("/api/actions", new CreateActionRequest
        { CabinetId = cabinet.Id, Action = ActionName.GetHistoricalProcessEvidence, Reason = "history" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(ActionRequestStatus.Approved, (await created.ReadAsync<ActionRequestView>())!.Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await user.PostJsonAsync("/api/actions", new CreateActionRequest
        { CabinetId = cabinet.Id, Action = ActionName.GetHistoricalProcessEvidence, Reason = "history",
            Parameters = new Dictionary<string, string> { ["path"] = "private" } })).StatusCode);
        Assert.Contains(JsonDocument.Parse(await agent.GetStringAsync("/api/agent/actions")).RootElement.EnumerateArray(),
            row => row.GetProperty("id").GetGuid() == action.Id);
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, Wire())).StatusCode);
        ActionRequest saved = await factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
        Assert.Null(saved.ResultOutput);
        ActionRequestView generic = (await (await user.GetAsync($"/api/actions/{action.Id}")).ReadAsync<ActionRequestView>())!;
        Assert.Null(generic.ResultOutput);
        Assert.Null(generic.CollectedData);
        using JsonDocument projected = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        Assert.Equal("complete", projected.RootElement.GetProperty("state").GetString());
        Assert.Equal("Start", projected.RootElement.GetProperty("evidence").GetProperty("events")[0].GetProperty("kind").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(Guid.NewGuid(), action.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync(Latest(cabinet.Id))).StatusCode);
    }

    [Fact]
    public async Task Strict_schema_and_limits_reject_without_persistence_or_payload_audit()
    {
        string good = Wire();
        string row = JsonDocument.Parse(good).RootElement.GetProperty("events")[0].GetRawText();
        string[] bad = ["null", "{}", good + new string(' ', 16384),
            good.Replace("\"version\":1", "\"version\":2"),
            good.Replace("\"version\":1", "\"version\":1,\"xml\":\"patient\""),
            good.Replace("\"version\":1", "\"version\":1,\"version\":1"),
            good.Replace("\"auditCoverageVerified\":false", "\"auditCoverageVerified\":true"),
            good.Replace("\"status\":\"Read\"", "\"status\":\"Denied\""),
            good.Replace("\"kind\":\"Start\"", "\"kind\":99"),
            good.Replace("\"processId\":1", "\"processId\":0"),
            good.Replace("\"recordId\":1", "\"recordId\":0"),
            good.Replace("\"events\":[" + row + "]", "\"events\":[" + row + "," + row + "]"),
            good.Replace("\"occurredUtc\":", "\"occurredUtc\":\"2020-01-01T00:00:00Z\",\"old\":"),
            good.Replace("\"windowStartUtc\":", "\"windowStartUtc\":\"2020-01-01T00:00:00Z\",\"old\":"),
            good.Replace("\"status\":\"Read\"", "\"status\":\"Read\",\"commandLine\":\"patient\""),
            Wire(65), Wire(1, ProcessEvidenceStatus.Read, true) ];
        foreach (string wire in bad)
        {
            var (_, agent, cabinet, action) = await SetupAsync();
            Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, wire)).StatusCode);
            ActionRequest saved = await factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
            Assert.Equal(ActionRequestStatus.Dispatched, saved.Status);
            Assert.Null(saved.CollectedDataJson);
            var audits = await factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().Where(a => a.CabinetId == cabinet.Id && a.Action == ActionName.GetHistoricalProcessEvidence).ToListAsync());
            Assert.Contains(audits, a => a.Event == AuditEvent.AgentReportResult && a.Result == AuditResult.Denied);
            Assert.DoesNotContain(audits, a => a.Details?.Contains("patient", StringComparison.Ordinal) == true);
        }
    }

    [Fact]
    public async Task Maximum_rows_null_record_id_and_partial_coverage_are_typed_without_other_action_data()
    {
        var (user, agent, cabinet, action) = await SetupAsync();
        string wire = Wire(64, ProcessEvidenceStatus.Partial, true).Replace("\"recordId\":1}", "\"recordId\":null}");
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, wire)).StatusCode);
        using JsonDocument result = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        Assert.Equal(64, result.RootElement.GetProperty("evidence").GetProperty("events").GetArrayLength());
        Assert.True(result.RootElement.GetProperty("evidence").GetProperty("truncated").GetBoolean());
        Assert.False(result.RootElement.GetProperty("evidence").GetProperty("auditCoverageVerified").GetBoolean());
        Assert.Equal(JsonValueKind.Null, result.RootElement.GetProperty("evidence").GetProperty("events")[0].GetProperty("recordId").ValueKind);
        var other = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = action.RequestedByUserId,
            RequestedUtc = DateTimeOffset.UtcNow.AddMinutes(1), Action = ActionName.GetWerMetadata,
            Status = ActionRequestStatus.Completed, ResultStatus = ActionStatus.Succeeded,
            ParametersJson = "{}", Reason = "other", CollectedDataJson = wire };
        await factory.WithDbAsync(async db => { db.ActionRequests.Add(other); await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(cabinet.Id, other.Id))).StatusCode);
        using JsonDocument latest = JsonDocument.Parse(await user.GetStringAsync(Latest(cabinet.Id)));
        Assert.Equal(action.Id, latest.RootElement.GetProperty("actionId").GetGuid());
    }

    [Fact]
    public async Task Failure_latest_foreign_agent_and_corrupt_saved_projection_are_bounded()
    {
        var (user, agent, cabinet, old) = await SetupAsync();
        string foreign = Guid.NewGuid().ToString("N");
        await TestClient.CreateApprovedCabinetAsync(factory, foreign, old.RequestedByUserId, clientName: Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.NotFound, (await Report(TestClient.CreateAgentClient(factory, foreign), old.Id, Wire())).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, old.Id, Wire(), ActionStatus.Failed)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, old.Id, null, ActionStatus.Failed)).StatusCode);
        var newer = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = old.RequestedByUserId,
            RequestedUtc = old.RequestedUtc.AddMinutes(1), Action = ActionName.GetHistoricalProcessEvidence,
            Status = ActionRequestStatus.Dispatched, ParametersJson = "{}", Reason = "later" };
        await factory.WithDbAsync(async db => { db.ActionRequests.Add(newer); await db.SaveChangesAsync(); });
        using JsonDocument latest = JsonDocument.Parse(await user.GetStringAsync(Latest(cabinet.Id)));
        Assert.Equal(newer.Id, latest.RootElement.GetProperty("actionId").GetGuid());
        Assert.Equal("pending", latest.RootElement.GetProperty("state").GetString());
        using JsonDocument failed = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, old.Id)));
        Assert.Equal("failed", failed.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, failed.RootElement.GetProperty("evidence").ValueKind);
        await factory.WithDbAsync(async db => { var row = await db.ActionRequests.SingleAsync(a => a.Id == old.Id);
            row.ResultStatus = ActionStatus.Succeeded; row.CollectedDataJson = "{\"patient\":\"secret\"}"; await db.SaveChangesAsync(); });
        HttpResponseMessage corrupt = await user.GetAsync(Pinned(cabinet.Id, old.Id));
        Assert.Equal(HttpStatusCode.BadGateway, corrupt.StatusCode);
        Assert.DoesNotContain("secret", await corrupt.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }
}
