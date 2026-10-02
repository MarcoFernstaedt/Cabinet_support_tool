using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class DisplayResultEndpointTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public DisplayResultEndpointTests(SupportApiFactory factory) => _factory = factory;
    private static string Latest(Guid id) => $"/api/cabinets/{id}/display-results/latest";
    private static string Pinned(Guid id, Guid action) => $"/api/cabinets/{id}/display-results/{action}";
    private const string Valid = "{\"observedAtUtc\":\"2026-10-02T12:00:00Z\",\"modeStatus\":\"Observed\",\"modes\":[{\"displayIndex\":0,\"widthPixels\":1920,\"heightPixels\":1080,\"refreshHz\":null}],\"modesTruncated\":false,\"scalingStatus\":\"NotCollected\",\"scalingPercent\":null,\"magnifierStatus\":\"NotCollected\",\"appZoomStatus\":\"NotCollected\"}";

    private async Task<(HttpClient User, HttpClient Agent, Cabinet Cabinet, ActionRequest Action)> SetupAsync()
    {
        (HttpClient userClient, User user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString("N"));
        string machine = Guid.NewGuid().ToString("N");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, machine, user.Id, clientName: Guid.NewGuid().ToString("N"));
        var action = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = user.Id,
            RequestedUtc = DateTimeOffset.UtcNow, Action = ActionName.GetDisplayDiagnostics,
            Status = ActionRequestStatus.Dispatched, ParametersJson = "{}", Reason = "Synthetic display test" };
        await _factory.WithDbAsync(async db => { db.ActionRequests.Add(action); await db.SaveChangesAsync(); });
        return (userClient, TestClient.CreateAgentClient(_factory, machine), cabinet, action);
    }

    private Task<HttpResponseMessage> Report(HttpClient agent, Guid action, string? data, ActionStatus status = ActionStatus.Succeeded, string? output = null) =>
        agent.PostJsonAsync("/api/agent/actions/result", new ActionResultDto { RequestId = action,
            Status = status, StartedAtUtc = DateTimeOffset.UtcNow, CompletedAtUtc = DateTimeOffset.UtcNow,
            CollectedData = data, Output = output });

    [Fact]
    public void Catalog_is_parameterless_observational()
    {
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.GetDisplayDiagnostics);
        Assert.Empty(entry.AllowedParameterKeys);
        Assert.False(entry.RequiresApproval);
        Assert.False(entry.IsDisruptive);
        Assert.False(entry.Batchable);
    }

    [Fact]
    public async Task Agent_wire_preserves_explicit_null_scaling_and_accepts_omitted_refresh()
    {
        var (user, agent, cabinet, action) = await SetupAsync();
        string wire = JsonSerializer.Serialize(new DisplayDiagnostics
        {
            ObservedAtUtc = DateTimeOffset.UtcNow,
            ModeStatus = DisplayModeStatus.Observed,
            Modes = [new DisplayModeObservation { DisplayIndex = 0, WidthPixels = 1920, HeightPixels = 1080 }],
            ModesTruncated = false,
            ScalingStatus = DisplaySessionStatus.NotCollected,
            MagnifierStatus = DisplaySessionStatus.NotCollected,
            AppZoomStatus = DisplaySessionStatus.NotCollected
        }, ContractJson.Default);
        Assert.Contains("\"scalingPercent\":null", wire);
        Assert.DoesNotContain("refreshHz", wire);
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, wire, output: "private text must not persist")).StatusCode);
        ActionRequest stored = await _factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
        Assert.Null(stored.ResultOutput);
        using JsonDocument response = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        Assert.Equal("complete", response.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, response.RootElement.GetProperty("display").GetProperty("scalingPercent").ValueKind);
    }

    [Fact]
    public async Task Ingest_and_project_exact_typed_fields_with_audited_read()
    {
        var (user, agent, cabinet, action) = await SetupAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, Valid)).StatusCode);
        using JsonDocument response = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        JsonElement root = response.RootElement;
        Assert.Equal(new[] { "cabinetId", "actionId", "state", "requestedAtUtc", "completedAtUtc", "display" }, root.EnumerateObject().Select(p => p.Name));
        Assert.Equal(cabinet.Id, root.GetProperty("cabinetId").GetGuid());
        Assert.Equal(action.Id, root.GetProperty("actionId").GetGuid());
        Assert.Equal("complete", root.GetProperty("state").GetString());
        JsonElement display = root.GetProperty("display");
        Assert.Equal(new[] { "observedAtUtc", "modeStatus", "modes", "modesTruncated", "scalingStatus", "scalingPercent", "magnifierStatus", "appZoomStatus" }, display.EnumerateObject().Select(p => p.Name));
        Assert.Equal("Observed", display.GetProperty("modeStatus").GetString());
        Assert.Equal("NotCollected", display.GetProperty("scalingStatus").GetString());
        Assert.Equal("NotCollected", display.GetProperty("magnifierStatus").GetString());
        Assert.Equal("NotCollected", display.GetProperty("appZoomStatus").GetString());
        Assert.Equal(JsonValueKind.Null, display.GetProperty("scalingPercent").ValueKind);
        Assert.Equal(JsonValueKind.Null, display.GetProperty("modes")[0].GetProperty("refreshHz").ValueKind);
        Assert.NotNull((await _factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id))).CollectedDataJson);
        Assert.Contains(await _factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().Where(a => a.CabinetId == cabinet.Id && a.Action == ActionName.GetDisplayDiagnostics).ToListAsync()),
            a => a.Event == AuditEvent.ListActions && a.Result == AuditResult.Success);
    }

    [Fact]
    public async Task Earlier_inaccessible_session_status_remains_readable()
    {
        var (user, agent, cabinet, action) = await SetupAsync();
        string earlier = Valid.Replace("\"scalingStatus\":\"NotCollected\"", "\"scalingStatus\":\"InteractiveSessionInaccessible\"")
            .Replace("\"magnifierStatus\":\"NotCollected\"", "\"magnifierStatus\":\"InteractiveSessionInaccessible\"");
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, earlier)).StatusCode);
        using JsonDocument response = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        JsonElement display = response.RootElement.GetProperty("display");
        Assert.Equal("InteractiveSessionInaccessible", display.GetProperty("scalingStatus").GetString());
        Assert.Equal("InteractiveSessionInaccessible", display.GetProperty("magnifierStatus").GetString());
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("{\"observedAtUtc\":\"2026-10-02T12:00:00Z\",\"modeStatus\":\"Observed\",\"modes\":[],\"modesTruncated\":false,\"scalingStatus\":\"NotCollected\",\"scalingPercent\":null,\"magnifierStatus\":\"NotCollected\",\"appZoomStatus\":\"NotCollected\"}")]
    public async Task Invalid_ingest_leaves_dispatched_row_unchanged(string data)
    {
        var (_, agent, _, action) = await SetupAsync();
        Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, data)).StatusCode);
        ActionRequest stored = await _factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
        Assert.Equal(ActionRequestStatus.Dispatched, stored.Status);
        Assert.Null(stored.CollectedDataJson);
        Assert.Contains(await _factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().Where(a => a.Action == ActionName.GetDisplayDiagnostics).ToListAsync()),
            a => a.Event == AuditEvent.AgentReportResult && a.Result == AuditResult.Denied);
    }

    [Fact]
    public async Task Corrupt_saved_display_refuses_read_and_audits_without_raw_data()
    {
        var (user, _, cabinet, action) = await SetupAsync();
        await _factory.WithDbAsync(async db =>
        {
            ActionRequest stored = await db.ActionRequests.SingleAsync(a => a.Id == action.Id);
            stored.Status = ActionRequestStatus.Completed;
            stored.ResultStatus = ActionStatus.Succeeded;
            stored.CollectedDataJson = "{\"private\":\"do not expose\"}";
            await db.SaveChangesAsync();
        });
        Assert.Equal(HttpStatusCode.BadGateway, (await user.GetAsync(Pinned(cabinet.Id, action.Id))).StatusCode);
        var audits = await _factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().Where(a => a.CabinetId == cabinet.Id && a.Action == ActionName.GetDisplayDiagnostics).ToListAsync());
        Assert.Contains(audits, a => a.Event == AuditEvent.ListActions && a.Result == AuditResult.Denied);
        Assert.DoesNotContain(audits, a => a.Details?.Contains("do not expose", StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task Schema_and_byte_limits_refuse_identity_duplicates_and_malformed_rows()
    {
        string[] bad = [
            Valid.Replace("\"modeStatus\":\"Observed\"", "\"modeStatus\":\"Observed\",\"monitorName\":\"patient\""),
            Valid.Replace("\"modeStatus\":\"Observed\"", "\"modeStatus\":\"Observed\",\"modeStatus\":\"Denied\""),
            Valid.Replace("\"displayIndex\":0", "\"displayIndex\":0,\"devicePath\":\"secret\""),
            Valid.Replace("\"displayIndex\":0", "\"displayIndex\":1"),
            Valid.Replace("\"widthPixels\":1920", "\"widthPixels\":-1"),
            Valid.Replace("\"refreshHz\":null", "\"refreshHz\":\"60\""),
            Valid.Replace("\"scalingPercent\":null", "\"scalingPercent\":125"),
            Valid.Replace("\"modeStatus\":\"Observed\"", "\"modeStatus\":99"),
            Valid.Replace("\"observedAtUtc\":\"2026-10-02T12:00:00Z\"", "\"observedAtUtc\":\"2026-10-02T12:00:00\""),
            Valid.Replace("\"observedAtUtc\":\"2026-10-02T12:00:00Z\"", "\"observedAtUtc\":\"yesterday\""),
            Valid.Replace("\"modesTruncated\":false", "\"modesTruncated\":true"),
            Valid.Replace("\"modesTruncated\":false", "\"modesTruncated\":\"false\""),
            Valid.Replace("\"modes\":[{\"displayIndex\":0,\"widthPixels\":1920,\"heightPixels\":1080,\"refreshHz\":null}]", "\"modes\":[]"),
            Valid.Replace("\"modes\":[{\"displayIndex\":0,\"widthPixels\":1920,\"heightPixels\":1080,\"refreshHz\":null}]", "\"modes\":[{\"displayIndex\":0,\"widthPixels\":1920,\"heightPixels\":1080},{\"displayIndex\":0,\"widthPixels\":1920,\"heightPixels\":1080}]"),
            Valid + new string(' ', 4096)
        ];
        foreach (string data in bad)
        {
            var (_, agent, _, action) = await SetupAsync();
            Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, data)).StatusCode);
            ActionRequest stored = await _factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
            Assert.Equal(ActionRequestStatus.Dispatched, stored.Status);
            Assert.Null(stored.CollectedDataJson);
        }
    }

    [Fact]
    public async Task Unavailable_modes_preserve_empty_rows_and_nullable_session_values()
    {
        var (user, agent, cabinet, action) = await SetupAsync();
        string unavailable = Valid.Replace("\"modeStatus\":\"Observed\"", "\"modeStatus\":\"Denied\"")
            .Replace("\"modes\":[{\"displayIndex\":0,\"widthPixels\":1920,\"heightPixels\":1080,\"refreshHz\":null}]", "\"modes\":[]");
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, unavailable)).StatusCode);
        using JsonDocument response = JsonDocument.Parse(await user.GetStringAsync(Latest(cabinet.Id)));
        JsonElement display = response.RootElement.GetProperty("display");
        Assert.Equal("Denied", display.GetProperty("modeStatus").GetString());
        Assert.Empty(display.GetProperty("modes").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, display.GetProperty("scalingPercent").ValueKind);
    }

    [Fact]
    public async Task Failed_result_cannot_persist_observation()
    {
        var (_, agent, _, action) = await SetupAsync();
        Assert.Equal(HttpStatusCode.BadRequest, (await Report(agent, action.Id, Valid, ActionStatus.Failed)).StatusCode);
        ActionRequest stored = await _factory.WithDbAsync(db => db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == action.Id));
        Assert.Equal(ActionRequestStatus.Dispatched, stored.Status);
        Assert.Null(stored.CollectedDataJson);
    }

    [Fact]
    public async Task Missing_and_other_action_types_never_substitute_latest()
    {
        var (user, _, cabinet, action) = await SetupAsync();
        await _factory.WithDbAsync(async db => { db.ActionRequests.Remove(await db.ActionRequests.SingleAsync(a => a.Id == action.Id)); await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Latest(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(cabinet.Id, action.Id))).StatusCode);
        var other = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = action.RequestedByUserId,
            RequestedUtc = DateTimeOffset.UtcNow, Action = ActionName.GetProcessList,
            Status = ActionRequestStatus.Dispatched, ParametersJson = "{}", Reason = "Other" };
        await _factory.WithDbAsync(async db => { db.ActionRequests.Add(other); await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Latest(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(cabinet.Id, other.Id))).StatusCode);
    }

    [Fact]
    public async Task Revoked_staff_cannot_read_latest_or_pinned()
    {
        var (user, _, cabinet, action) = await SetupAsync();
        await _factory.WithDbAsync(async db => { User stored = await db.Users.SingleAsync(u => u.Id == action.RequestedByUserId); stored.SecurityStamp = Guid.NewGuid(); await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.GetAsync(Latest(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.GetAsync(Pinned(cabinet.Id, action.Id))).StatusCode);
    }

    [Fact]
    public async Task Eight_indexed_rows_are_accepted_without_truncation()
    {
        var (user, agent, cabinet, action) = await SetupAsync();
        string rows = string.Join(',', Enumerable.Range(0, 8).Select(i => $"{{\"displayIndex\":{i},\"widthPixels\":1920,\"heightPixels\":1080,\"refreshHz\":60}}"));
        string data = Valid.Replace("\"modes\":[{\"displayIndex\":0,\"widthPixels\":1920,\"heightPixels\":1080,\"refreshHz\":null}]", $"\"modes\":[{rows}]")
            .Replace("\"modesTruncated\":false", "\"modesTruncated\":true");
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, action.Id, data)).StatusCode);
        using JsonDocument response = JsonDocument.Parse(await user.GetStringAsync(Latest(cabinet.Id)));
        Assert.Equal(8, response.RootElement.GetProperty("display").GetProperty("modes").GetArrayLength());
        Assert.True(response.RootElement.GetProperty("display").GetProperty("modesTruncated").GetBoolean());
    }

    [Fact]
    public async Task Denied_action_projects_failed_without_display()
    {
        var (user, _, cabinet, action) = await SetupAsync();
        await _factory.WithDbAsync(async db => { ActionRequest stored = await db.ActionRequests.SingleAsync(a => a.Id == action.Id); stored.Status = ActionRequestStatus.Denied; await db.SaveChangesAsync(); });
        using JsonDocument response = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, action.Id)));
        Assert.Equal("failed", response.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, response.RootElement.GetProperty("display").ValueKind);
    }

    [Fact]
    public async Task Pending_failed_pinned_latest_and_auth_are_separate()
    {
        var (user, agent, cabinet, old) = await SetupAsync();
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync(Latest(cabinet.Id))).StatusCode);
        using JsonDocument pending = JsonDocument.Parse(await user.GetStringAsync(Latest(cabinet.Id)));
        Assert.Equal("pending", pending.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, pending.RootElement.GetProperty("display").ValueKind);
        Assert.Equal(JsonValueKind.Null, pending.RootElement.GetProperty("completedAtUtc").ValueKind);
        Assert.Equal(HttpStatusCode.NoContent, (await Report(agent, old.Id, null, ActionStatus.Failed)).StatusCode);
        using JsonDocument failed = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, old.Id)));
        Assert.Equal("failed", failed.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, failed.RootElement.GetProperty("display").ValueKind);
        var newer = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = old.RequestedByUserId,
            RequestedUtc = old.RequestedUtc.AddMinutes(1), Action = ActionName.GetDisplayDiagnostics,
            Status = ActionRequestStatus.Dispatched, ParametersJson = "{}", Reason = "Next" };
        await _factory.WithDbAsync(async db => { db.ActionRequests.Add(newer); await db.SaveChangesAsync(); });
        using JsonDocument latest = JsonDocument.Parse(await user.GetStringAsync(Latest(cabinet.Id)));
        Assert.Equal(newer.Id, latest.RootElement.GetProperty("actionId").GetGuid());
        using JsonDocument pinned = JsonDocument.Parse(await user.GetStringAsync(Pinned(cabinet.Id, old.Id)));
        Assert.Equal(old.Id, pinned.RootElement.GetProperty("actionId").GetGuid());
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(Guid.NewGuid(), old.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(Pinned(cabinet.Id, Guid.NewGuid()))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync(Pinned(cabinet.Id, old.Id))).StatusCode);
    }
}
