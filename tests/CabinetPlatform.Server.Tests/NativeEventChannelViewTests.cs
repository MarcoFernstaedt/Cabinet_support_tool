using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Tests;

public sealed class NativeEventChannelViewTests(SupportApiFactory factory) : IClassFixture<SupportApiFactory>
{
    [Fact]
    public async Task Supervisor_native_view_roundtrips_and_rep_request_expands_only_saved_channels()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, Unique());
        var (rep, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Unique());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, Unique(), user.Id, clientName: Unique());
        var body = Body(new[] { "Microsoft-Windows-WindowsUpdateClient/Operational" });
        var response = await supervisor.PostJsonAsync("/api/event-log-views", body);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = await response.ReadAsync<JsonElement>();
        Guid id = created.GetProperty("id").GetGuid();
        Assert.Equal("Microsoft-Windows-WindowsUpdateClient/Operational", created.GetProperty("channelNames")[0].GetString());
        var read = await (await rep.GetAsync($"/api/event-log-views/{id}")).ReadAsync<JsonElement>();
        Assert.Equal(created.GetProperty("channelNames").GetRawText(), read.GetProperty("channelNames").GetRawText());
        var action = await rep.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            CabinetId = cabinet.Id, Action = ActionName.RunEventLogView, Reason = "Synthetic channel diagnostic",
            Parameters = new Dictionary<string, string> { [ActionParameterKeys.EventLogViewId] = id.ToString() }
        });
        Assert.Equal(HttpStatusCode.Created, action.StatusCode);
        var request = await action.ReadAsync<ActionRequestView>();
        using var definition = JsonDocument.Parse(request!.Parameters[ActionParameterKeys.EventLogViewDefinition]);
        Assert.Equal(read.GetProperty("channelNames").GetRawText(), definition.RootElement.GetProperty("channelNames").GetRawText());
        Assert.Equal(HttpStatusCode.Forbidden, (await rep.PostJsonAsync("/api/event-log-views", body)).StatusCode);
        var update = await supervisor.PutJsonAsync($"/api/event-log-views/{id}", Body(new[] { "Vendor/Product Admin" }));
        Assert.Equal(HttpStatusCode.OK, update.StatusCode);
        var updated = await (await rep.GetAsync($"/api/event-log-views/{id}")).ReadAsync<JsonElement>();
        Assert.Equal("Vendor/Product Admin", updated.GetProperty("channelNames")[0].GetString());
    }

    [Theory]
    [InlineData("C:/logs/sample.evtx")]
    [InlineData("//server/Application")]
    [InlineData("Vendor/../Application")]
    [InlineData("*[System[Level=2]]")]
    [InlineData("Vendor/Operational\n")]
    [InlineData("Vendor//Operational")]
    [InlineData("")]
    public async Task Invalid_channel_names_are_refused_on_authenticated_create(string channel)
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, Unique());
        Assert.Equal(HttpStatusCode.BadRequest, (await supervisor.PostJsonAsync("/api/event-log-views", Body(new[] { channel }))).StatusCode);
    }

    [Fact]
    public async Task Channel_count_nulls_and_length_are_bounded_at_saved_view_boundary()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, Unique());
        foreach (var channels in new[] { Enumerable.Range(0, 17).Select(i => $"Vendor/Channel{i}").ToArray(), new[] { new string('a', 513) }, new string[] { null! }, null! })
            Assert.Equal(HttpStatusCode.BadRequest, (await supervisor.PostJsonAsync("/api/event-log-views", Body(channels))).StatusCode);
    }

    [Fact]
    public async Task Existing_text_column_retains_legacy_arrays_and_versions_native_payload_without_schema_change()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, Unique());
        var legacyResponse = await supervisor.PostJsonAsync("/api/event-log-views", new CreateEventLogViewRequest
        {
            DisplayName = Unique(), LogNames = new[] { EventLogName.System }, Reason = "Legacy compatibility"
        });
        var legacy = await legacyResponse.ReadAsync<EventLogViewDto>();
        string legacyJson = await factory.WithDbAsync(async db => (await db.EventLogViews.FindAsync(legacy!.Id))!.LogNamesJson);
        Assert.Equal("[\"System\"]", legacyJson);
        var nativeResponse = await supervisor.PostJsonAsync("/api/event-log-views", Body(new[] { "Vendor/Exact", "vendor/exact" }));
        var native = await nativeResponse.ReadAsync<EventLogViewDto>();
        Assert.Equal(new[] { "Vendor/Exact" }, native!.ChannelNames);
        string nativeJson = await factory.WithDbAsync(async db => (await db.EventLogViews.FindAsync(native.Id))!.LogNamesJson);
        using var stored = JsonDocument.Parse(nativeJson);
        Assert.Equal(1, stored.RootElement.GetProperty("version").GetInt32());
        Assert.Equal("Vendor/Exact", stored.RootElement.GetProperty("channelNames")[0].GetString());
        // This is exactly the old server's enum-array deserializer. It cannot silently read a subset.
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<EventLogName[]>(nativeJson, TestClient.Json));
        var downgrade = await supervisor.PutJsonAsync($"/api/event-log-views/{native.Id}", new UpdateEventLogViewRequest
        {
            DisplayName = native.DisplayName, LogNames = new[] { EventLogName.Application }, ChannelNames = Array.Empty<string>(),
            MinimumLevel = EventLogLevel.Warning, DefaultWindowHours = 24, MaximumEntries = 100, Reason = "Explicit rollback to legacy view"
        });
        Assert.Equal(HttpStatusCode.OK, downgrade.StatusCode);
        string restored = await factory.WithDbAsync(async db => (await db.EventLogViews.FindAsync(native.Id))!.LogNamesJson);
        Assert.Equal("[\"Application\"]", restored);
    }

    private static object Body(string[] channels) => new
    {
        displayName = Unique(), channelNames = channels, logNames = Array.Empty<EventLogName>(),
        minimumLevel = EventLogLevel.Verbose, defaultWindowHours = 24, maximumEntries = 100,
        reason = "Synthetic native event view"
    };
    private static string Unique() => $"native-{Guid.NewGuid():N}"[..24];
}
