using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class EventLogResultEndpointTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public EventLogResultEndpointTests(SupportApiFactory factory) => _factory = factory;

    private static string Url(Guid cabinetId) => $"/api/cabinets/{cabinetId}/event-log-results/latest";
    private static string Unique() => Guid.NewGuid().ToString("N");

    private async Task<(HttpClient Client, Cabinet Cabinet, ActionRequest Action)> SetupAsync()
    {
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique());
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Unique(), user.Id, clientName: Unique());
        var definition = new EventLogViewDefinition
        {
            ViewId = Guid.NewGuid(), DisplayName = "Disk errors", LogNames = [EventLogName.System],
            Sources = ["Disk"], MinimumLevel = EventLogLevel.Warning, WindowHours = 12, MaximumEntries = 500
        };
        var action = new ActionRequest
        {
            CabinetId = cabinet.Id, RequestedByUserId = user.Id, RequestedUtc = DateTimeOffset.UtcNow,
            Action = ActionName.RunEventLogView, Status = ActionRequestStatus.Dispatched,
            ParametersJson = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                [ActionParameterKeys.EventLogViewId] = definition.ViewId.ToString(),
                [ActionParameterKeys.EventLogViewDefinition] = JsonSerializer.Serialize(definition, ContractJson.Default),
                [ActionParameterKeys.HoursOfHistory] = "12"
            }, ContractJson.Default), Reason = "Test"
        };
        await _factory.WithDbAsync(async db => { db.ActionRequests.Add(action); await db.SaveChangesAsync(); });
        return (client, cabinet, action);
    }

    private async Task CompleteAsync(ActionRequest action, string? data, ActionStatus status = ActionStatus.Succeeded)
    {
        await _factory.WithDbAsync(async db =>
        {
            ActionRequest row = await db.ActionRequests.SingleAsync(a => a.Id == action.Id);
            row.Status = ActionRequestStatus.Completed;
            row.ResultStatus = status;
            row.CompletedUtc = DateTimeOffset.UtcNow;
            row.CollectedDataJson = data;
            await db.SaveChangesAsync();
        });
    }

    private static string Result(ActionRequest action, int count = 1, bool truncated = false,
        EventChannelAccess access = EventChannelAccess.Readable) => JsonSerializer.Serialize(new EventLogViewResultDto
    {
        ViewId = JsonDocument.Parse(action.ParametersJson).RootElement.GetProperty(ActionParameterKeys.EventLogViewDefinition)
            .GetString() is { } raw ? JsonSerializer.Deserialize<EventLogViewDefinition>(raw, ContractJson.Default)!.ViewId : Guid.Empty,
        ViewDisplayName = "Disk errors", WindowHours = 12, Truncated = truncated,
        ChannelReads = [new EventChannelReadResult { Name = "System", Access = access, RecordsRead = count }],
        Entries = Enumerable.Range(0, count).Select(i => new EventLogEntry
        {
            ChannelName = "System", Source = "Disk", Level = EventLogLevel.Error,
            EventId = 7, TimeCreatedUtc = DateTimeOffset.UtcNow.AddMinutes(-i), Message = "I/O error"
        }).ToArray()
    }, ContractJson.Default);

    [Fact]
    public async Task Completed_result_is_a_narrow_cabinet_bound_projection()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, Result(action));
        HttpResponseMessage response = await client.GetAsync(Url(cabinet.Id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using JsonDocument json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        JsonElement root = json.RootElement;
        Assert.Equal(new[] { "cabinetId", "actionId", "state", "requestedAtUtc", "completedAtUtc", "viewId", "viewDisplayName", "requestedChannels", "requestedProviders", "channelReads", "truncated", "entries" },
            root.EnumerateObject().Select(p => p.Name));
        Assert.Equal("complete", root.GetProperty("state").GetString());
        Assert.Equal(cabinet.Id, root.GetProperty("cabinetId").GetGuid());
        Assert.Equal(action.Id, root.GetProperty("actionId").GetGuid());
        Assert.Equal("System", root.GetProperty("requestedChannels")[0].GetString());
        Assert.Equal("Disk", root.GetProperty("requestedProviders")[0].GetString());
        Assert.Equal(new[] { "channel", "provider", "level", "eventId", "occurredAt", "message" },
            root.GetProperty("entries")[0].EnumerateObject().Select(p => p.Name));
        Assert.False(root.TryGetProperty("resultOutput", out _));
    }

    [Fact]
    public async Task Pending_and_failed_actions_do_not_expose_data()
    {
        var (client, cabinet, action) = await SetupAsync();
        using JsonDocument pending = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.Equal("pending", pending.RootElement.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, pending.RootElement.GetProperty("completedAtUtc").ValueKind);
        Assert.Empty(pending.RootElement.GetProperty("entries").EnumerateArray());
        await CompleteAsync(action, Result(action), ActionStatus.Failed);
        using JsonDocument failed = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.Equal("failed", failed.RootElement.GetProperty("state").GetString());
        Assert.Empty(failed.RootElement.GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task Only_the_named_cabinets_event_view_action_is_selected()
    {
        var (client, cabinet, action) = await SetupAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Url(Guid.NewGuid()))).StatusCode);
        await _factory.WithDbAsync(async db =>
        {
            ActionRequest row = await db.ActionRequests.SingleAsync(a => a.Id == action.Id);
            row.Action = ActionName.GetProcessList;
            await db.SaveChangesAsync();
        });
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("{}")]
    public async Task Malformed_completed_payload_fails_closed(string data)
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, data);
        Assert.Equal(HttpStatusCode.BadGateway, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
    }

    [Fact]
    public async Task Mismatched_result_identity_fails_closed()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, Result(action).Replace("Disk errors", "Other view"));
        Assert.Equal(HttpStatusCode.BadGateway, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
    }

    [Fact]
    public async Task Partial_reads_are_visible_even_with_an_empty_record_set()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, Result(action, 0, access: EventChannelAccess.AccessDenied));
        using JsonDocument json = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.Equal("partial", json.RootElement.GetProperty("state").GetString());
        Assert.Equal("accessDenied", json.RootElement.GetProperty("channelReads")[0].GetProperty("outcome").GetString());
        Assert.Equal("System", json.RootElement.GetProperty("channelReads")[0].GetProperty("channelName").GetString());
    }

    [Fact]
    public async Task Large_result_has_a_fixed_record_and_byte_ceiling()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, Result(action, 500, truncated: false));
        HttpResponseMessage response = await client.GetAsync(Url(cabinet.Id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        byte[] bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(bytes.Length < 128 * 1024);
        using JsonDocument json = JsonDocument.Parse(bytes);
        Assert.True(json.RootElement.GetProperty("truncated").GetBoolean());
        Assert.Equal(100, json.RootElement.GetProperty("entries").GetArrayLength());
    }

    [Fact]
    public async Task Valid_dispatch_boundary_view_with_fifty_providers_and_long_channel_is_projected()
    {
        var (client, cabinet, action) = await SetupAsync();
        string channel = new('A', 512);
        string[] providers = Enumerable.Range(0, 50).Select(i => $"P{i:D2}" + new string('x', 252)).ToArray();
        var definition = new EventLogViewDefinition
        {
            ViewId = Guid.NewGuid(), DisplayName = "Boundary view", LogNames = [EventLogName.System],
            ChannelNames = [channel], Sources = providers, MinimumLevel = EventLogLevel.Warning,
            WindowHours = 12, MaximumEntries = 500
        };
        var result = new EventLogViewResultDto
        {
            ViewId = definition.ViewId, ViewDisplayName = definition.DisplayName, WindowHours = 12, Truncated = false,
            ChannelReads =
            [
                new EventChannelReadResult { Name = "System", Access = EventChannelAccess.Readable, RecordsRead = 0 },
                new EventChannelReadResult { Name = channel, Access = EventChannelAccess.Readable, RecordsRead = 1 }
            ],
            Entries = [new EventLogEntry { ChannelName = channel, Source = providers[0], Level = EventLogLevel.Error,
                EventId = 7, TimeCreatedUtc = DateTimeOffset.UtcNow, Message = "Boundary record" }]
        };
        await _factory.WithDbAsync(async db =>
        {
            ActionRequest row = await db.ActionRequests.SingleAsync(a => a.Id == action.Id);
            row.ParametersJson = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                [ActionParameterKeys.EventLogViewId] = definition.ViewId.ToString(),
                [ActionParameterKeys.EventLogViewDefinition] = JsonSerializer.Serialize(definition, ContractJson.Default),
                [ActionParameterKeys.HoursOfHistory] = "12"
            }, ContractJson.Default);
            row.Status = ActionRequestStatus.Completed;
            row.ResultStatus = ActionStatus.Succeeded;
            row.CompletedUtc = DateTimeOffset.UtcNow;
            row.CollectedDataJson = JsonSerializer.Serialize(result, ContractJson.Default);
            await db.SaveChangesAsync();
        });
        HttpResponseMessage response = await client.GetAsync(Url(cabinet.Id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using JsonDocument json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(channel, json.RootElement.GetProperty("requestedChannels")[1].GetString());
        Assert.Equal(50, json.RootElement.GetProperty("requestedProviders").GetArrayLength());
        Assert.Equal(providers[0], json.RootElement.GetProperty("entries")[0].GetProperty("provider").GetString());
        Assert.Equal("readable", json.RootElement.GetProperty("channelReads")[1].GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task Agent_normalized_provider_scope_with_surrounding_spaces_is_readable()
    {
        var (client, cabinet, action) = await SetupAsync();
        string provider = "D" + new string('x', 254);
        var definition = new EventLogViewDefinition
        {
            ViewId = Guid.NewGuid(), DisplayName = "Provider scope", LogNames = [EventLogName.System],
            Sources = [$" {provider} ", " Disk "], MinimumLevel = EventLogLevel.Warning,
            WindowHours = 12, MaximumEntries = 500
        };
        var result = new EventLogViewResultDto
        {
            ViewId = definition.ViewId, ViewDisplayName = definition.DisplayName, WindowHours = 12,
            Truncated = false,
            ChannelReads = [new EventChannelReadResult { Name = "System", Access = EventChannelAccess.Readable, RecordsRead = 1 }],
            Entries = [new EventLogEntry { ChannelName = "System", Source = provider, Level = EventLogLevel.Error,
                EventId = 7, TimeCreatedUtc = DateTimeOffset.UtcNow, Message = "Provider read" }]
        };
        await _factory.WithDbAsync(async db =>
        {
            ActionRequest row = await db.ActionRequests.SingleAsync(a => a.Id == action.Id);
            row.ParametersJson = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                [ActionParameterKeys.EventLogViewId] = definition.ViewId.ToString(),
                [ActionParameterKeys.EventLogViewDefinition] = JsonSerializer.Serialize(definition, ContractJson.Default),
                [ActionParameterKeys.HoursOfHistory] = "12"
            }, ContractJson.Default);
            row.Status = ActionRequestStatus.Completed;
            row.ResultStatus = ActionStatus.Succeeded;
            row.CompletedUtc = DateTimeOffset.UtcNow;
            row.CollectedDataJson = JsonSerializer.Serialize(result, ContractJson.Default);
            await db.SaveChangesAsync();
        });
        HttpResponseMessage response = await client.GetAsync(Url(cabinet.Id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using JsonDocument json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(provider, json.RootElement.GetProperty("requestedProviders")[0].GetString());
        Assert.Equal("Disk", json.RootElement.GetProperty("requestedProviders")[1].GetString());
        Assert.Equal(provider, json.RootElement.GetProperty("entries")[0].GetProperty("provider").GetString());
    }

    [Fact]
    public async Task Duplicate_result_identity_fields_are_not_accepted()
    {
        var (client, cabinet, action) = await SetupAsync();
        string result = Result(action);
        await CompleteAsync(action, result.Replace("\"viewId\":", $"\"viewId\":\"{Guid.NewGuid()}\",\"viewId\":"));
        Assert.Equal(HttpStatusCode.BadGateway, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
    }

    [Fact]
    public async Task Deactivated_staff_is_forbidden()
    {
        var (client, cabinet, action) = await SetupAsync();
        await _factory.WithDbAsync(async db =>
        {
            User user = await db.Users.SingleAsync(u => u.Id == action.RequestedByUserId);
            user.IsActive = false;
            await db.SaveChangesAsync();
        });
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
    }

    [Fact]
    public async Task Newer_pending_run_supersedes_an_earlier_completed_run()
    {
        var (client, cabinet, oldAction) = await SetupAsync();
        await CompleteAsync(oldAction, Result(oldAction));
        Guid newerId = await _factory.WithDbAsync(async db =>
        {
            var next = new ActionRequest
            {
                CabinetId = cabinet.Id, RequestedByUserId = oldAction.RequestedByUserId,
                RequestedUtc = oldAction.RequestedUtc.AddMinutes(1), Action = ActionName.RunEventLogView,
                Status = ActionRequestStatus.Approved, ParametersJson = oldAction.ParametersJson, Reason = "Again"
            };
            db.ActionRequests.Add(next);
            await db.SaveChangesAsync();
            return next.Id;
        });
        using JsonDocument json = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.Equal(newerId, json.RootElement.GetProperty("actionId").GetGuid());
        Assert.Equal("pending", json.RootElement.GetProperty("state").GetString());
        Assert.Empty(json.RootElement.GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task Newer_result_with_wrong_channel_is_rejected()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, Result(action).Replace("\"channelName\":\"System\"", "\"channelName\":\"Security\""));
        Assert.Equal(HttpStatusCode.BadGateway, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
    }

    [Fact]
    public async Task Clipped_message_is_marked_truncated()
    {
        var (client, cabinet, action) = await SetupAsync();
        await CompleteAsync(action, Result(action).Replace("I/O error", new string('x', 2048)));
        using JsonDocument json = JsonDocument.Parse(await client.GetStringAsync(Url(cabinet.Id)));
        Assert.True(json.RootElement.GetProperty("truncated").GetBoolean());
        Assert.True(json.RootElement.GetProperty("entries")[0].GetProperty("message").GetString()!.Length <= 512);
    }

    [Fact]
    public async Task Anonymous_and_inactive_staff_cannot_read_results()
    {
        var (client, cabinet, _) = await SetupAsync();
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync(Url(cabinet.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(Url(cabinet.Id))).StatusCode);
    }
}
