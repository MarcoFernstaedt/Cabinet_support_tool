using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class ProcessResultEndpointTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public ProcessResultEndpointTests(SupportApiFactory factory) => _factory = factory;
    private static string Url(Guid cabinet) => $"/api/cabinets/{cabinet}/process-results/latest";
    private static string Pinned(Guid cabinet, Guid action) => $"/api/cabinets/{cabinet}/process-results/{action}";

    private async Task<(HttpClient Client, Cabinet Cabinet, ActionRequest Action)> SetupAsync()
    {
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString("N"));
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString("N"), user.Id, clientName: Guid.NewGuid().ToString("N"));
        var action = new ActionRequest
        {
            CabinetId = cabinet.Id, RequestedByUserId = user.Id, RequestedUtc = DateTimeOffset.UtcNow,
            Action = ActionName.GetProcessList, Status = ActionRequestStatus.Dispatched,
            ParametersJson = "{}", Reason = "Test"
        };
        await _factory.WithDbAsync(async db => { db.ActionRequests.Add(action); await db.SaveChangesAsync(); });
        return (client, cabinet, action);
    }

    private async Task CompleteAsync(ActionRequest action, string data, ActionStatus result = ActionStatus.Succeeded)
    {
        await _factory.WithDbAsync(async db =>
        {
            ActionRequest row = await db.ActionRequests.SingleAsync(a => a.Id == action.Id);
            row.Status = ActionRequestStatus.Completed;
            row.ResultStatus = result;
            row.CompletedUtc = DateTimeOffset.UtcNow;
            row.CollectedDataJson = data;
            await db.SaveChangesAsync();
        });
    }

    private const string Process = "{\"name\":\"clinic.exe\",\"pid\":42,\"cpuPercent\":null,\"workingSetBytes\":null,\"threadCount\":null,\"handleCount\":null,\"selectionIdentity\":{\"executablePath\":\"C:\\\\secret\\\\patient.exe\"},\"executablePath\":\"SENSITIVE\"}";

    [Fact]
    public async Task Completed_result_projects_only_explicit_display_fields_and_nullable_counters()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, $"[{Process}]");
        using JsonDocument doc = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        JsonElement root = doc.RootElement;
        Assert.Equal(new[] { "cabinetId", "actionId", "state", "requestedAtUtc", "completedAtUtc", "truncated", "processes" }, root.EnumerateObject().Select(p => p.Name));
        Assert.Equal(cabinet.Id, root.GetProperty("cabinetId").GetGuid());
        Assert.Equal(action.Id, root.GetProperty("actionId").GetGuid());
        Assert.Equal("complete", root.GetProperty("state").GetString());
        Assert.False(root.GetProperty("truncated").GetBoolean());
        JsonElement process = root.GetProperty("processes")[0];
        Assert.Equal(new[] { "name", "pid", "cpuPercent", "workingSetBytes", "threadCount", "handleCount" }, process.EnumerateObject().Select(p => p.Name));
        Assert.Equal("clinic.exe", process.GetProperty("name").GetString());
        Assert.Equal(42, process.GetProperty("pid").GetInt32());
        Assert.Equal(JsonValueKind.Null, process.GetProperty("cpuPercent").ValueKind);
        Assert.DoesNotContain("SENSITIVE", root.GetRawText());
        Assert.DoesNotContain("secret", root.GetRawText());
        Assert.Equal(action.RequestedUtc.ToUnixTimeSeconds(), root.GetProperty("requestedAtUtc").GetDateTimeOffset().ToUnixTimeSeconds());
    }

    [Fact]
    public async Task Pending_and_failed_never_expose_saved_data()
    {
        var (client, cabinet, action) = await SetupAsync();
        using JsonDocument pending = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.Equal("pending", pending.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, pending.RootElement.GetProperty("completedAtUtc").ValueKind);
        Assert.Empty(pending.RootElement.GetProperty("processes").EnumerateArray());
        await CompleteAsync(action, $"[{Process}]", ActionStatus.Failed);
        using JsonDocument failed = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.Equal("failed", failed.RootElement.GetProperty("state").GetString());
        Assert.Empty(failed.RootElement.GetProperty("processes").EnumerateArray());
    }

    [Fact]
    public async Task Latest_changes_but_pinned_stays_on_exact_action()
    {
        var (client, cabinet, old) = await SetupAsync();
        await CompleteAsync(old, $"[{Process}]");
        var newer = new ActionRequest { CabinetId = cabinet.Id, RequestedByUserId = old.RequestedByUserId,
            RequestedUtc = old.RequestedUtc.AddMinutes(1), Action = ActionName.GetProcessList,
            Status = ActionRequestStatus.Dispatched, ParametersJson = "{}", Reason = "Again" };
        await _factory.WithDbAsync(async db => { db.ActionRequests.Add(newer); await db.SaveChangesAsync(); });
        using JsonDocument latest = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.Equal(newer.Id, latest.RootElement.GetProperty("actionId").GetGuid());
        Assert.Equal("pending", latest.RootElement.GetProperty("state").GetString());
        using JsonDocument pinned = JsonDocument.Parse(await client.GetStringAsync(Pinned(cabinet.Id, old.Id)));
        Assert.Equal(old.Id, pinned.RootElement.GetProperty("actionId").GetGuid());
        Assert.Equal(42, pinned.RootElement.GetProperty("processes")[0].GetProperty("pid").GetInt32());
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Pinned(Guid.NewGuid(), old.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Pinned(cabinet.Id, Guid.NewGuid()))).StatusCode);
    }

    [Fact]
    public async Task Other_action_type_cannot_be_read_as_processes()
    {
        var (client, cabinet, action) = await SetupAsync();
        await _factory.WithDbAsync(async db => { var row = await db.ActionRequests.SingleAsync(a => a.Id == action.Id); row.Action = ActionName.CollectEventLogs; await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Pinned(cabinet.Id, action.Id))).StatusCode);
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("{}")]
    [InlineData("[null]")]
    [InlineData("[{\"name\":44,\"pid\":2}]")]
    [InlineData("[{\"name\":\"x\",\"pid\":-1}]")]
    [InlineData("[{\"name\":\"x\",\"pid\":2,\"cpuPercent\":\"oops\"}]")]
    [InlineData("[{\"name\":\"x\",\"pid\":2,\"workingSetBytes\":-1}]")]
    [InlineData("[{\"name\":\"C:\\\\secret\\\\patient.exe\",\"pid\":2}]")]
    [InlineData("[{\"name\":\"/private/patient.exe\",\"pid\":2}]")]
    [InlineData("[{\"name\":\"x\",\"pid\":2,\"pid\":3}]")]
    [InlineData("[{\"name\":\"x\",\"pid\":2},{\"name\":\"y\",\"pid\":2}]")]
    public async Task Invalid_or_duplicate_rows_fail_closed(string data)
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, data);
        Assert.Equal(HttpStatusCode.BadGateway, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.BadGateway, (await client.GetAsync(Pinned(cabinet.Id, action.Id))).StatusCode);
    }

    [Fact]
    public async Task More_than_200_rows_are_truncated_and_response_is_bounded()
    {
        var (client, cabinet, action) = await SetupAsync();
        string data = "[" + string.Join(',', Enumerable.Range(1, 230).Select(i => $"{{\"name\":\"x\",\"pid\":{i}}}")) + "]";
        await CompleteAsync(action, data);
        HttpResponseMessage response = await client.GetAsync(Url(cabinet.Id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        byte[] bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(bytes.Length <= 64 * 1024);
        using JsonDocument doc = JsonDocument.Parse(bytes);
        Assert.True(doc.RootElement.GetProperty("truncated").GetBoolean());
        Assert.Equal(200, doc.RootElement.GetProperty("processes").GetArrayLength());
    }

    [Fact]
    public async Task Oversized_stored_data_fails_without_echoing_payload()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, "[" + new string('x', 600 * 1024) + "]");
        HttpResponseMessage response = await client.GetAsync(Pinned(cabinet.Id, action.Id));
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.DoesNotContain(new string('x', 100), await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Long_display_names_are_clipped_by_byte_ceiling()
    {
        var (client, cabinet, action) = await SetupAsync();
        string data = "[" + string.Join(',', Enumerable.Range(1, 200).Select(i =>
            $"{{\"name\":\"{new string('界', 256)}\",\"pid\":{i}}}")) + "]";
        await CompleteAsync(action, data);
        HttpResponseMessage response = await client.GetAsync(Url(cabinet.Id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        byte[] bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(bytes.Length <= 64 * 1024);
        using JsonDocument doc = JsonDocument.Parse(bytes);
        Assert.True(doc.RootElement.GetProperty("truncated").GetBoolean());
        Assert.InRange(doc.RootElement.GetProperty("processes").GetArrayLength(), 1, 199);
    }

    [Fact]
    public async Task Anonymous_and_revoked_staff_cannot_read_latest_or_pinned()
    {
        var (client, cabinet, action) = await SetupAsync();
        foreach (string url in new[] { Url(cabinet.Id), Pinned(cabinet.Id, action.Id) })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync(url)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(url)).StatusCode);
        }
        await _factory.WithDbAsync(async db => { var user = await db.Users.SingleAsync(u => u.Id == action.RequestedByUserId); user.SecurityStamp = Guid.NewGuid(); await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Pinned(cabinet.Id, action.Id))).StatusCode);
    }
}
