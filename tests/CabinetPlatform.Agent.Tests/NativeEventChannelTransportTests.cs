using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Tests;

public sealed class NativeEventChannelTransportTests(DiagnosticConsoleTestHost host) : IClassFixture<DiagnosticConsoleTestHost>
{
    private readonly ConsoleTestHost _host = host;
    private async Task<(MachineTabViewModel Tab, ApiClient Api, HttpClient Agent, Cabinet Cabinet)> OpenAsync()
    {
        var name = $"demo-{Guid.NewGuid():N}";
        await _host.CreateUserAsync(Role.Supervisor, name);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = name, Password = ConsoleTestHost.KnownPassword }, default);
        var announcer = new RecordingLiveRegionAnnouncer();
        var tab = new MachineTabViewModel(api,
            new ActionInvoker(api, ScriptedActionDialog.Accepting("Synthetic diagnostic regression"), announcer, session),
            session, announcer, TimeProvider.System);
        var cabinet = await _host.CreateCabinetAsync($"SYNTHETIC-{Guid.NewGuid():N}");
        var agent = _host.CreateClient();
        agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
        agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", cabinet.MachineId);
        using var checkin = await agent.PostAsJsonAsync("/api/agent/checkin", new CheckInPayload
        {
            MachineId = cabinet.MachineId, AgentVersion = "synthetic-demo",
            CollectedAtUtc = DateTimeOffset.UtcNow,
            System = new SystemInfo { Hostname = cabinet.Hostname, AnyUserLoggedOn = false, TimeZoneId = "UTC" }
        }, AgentJson.SerializerOptions);
        checkin.EnsureSuccessStatusCode();
        await tab.LoadAsync(cabinet.Id);
        Assert.Null(tab.ErrorMessage);
        Assert.Equal(cabinet.Hostname, tab.CabinetHostname);
        return (tab, api, agent, cabinet);
    }

    private static async Task<ActionRequestDto> DispatchAsync(MachineTabViewModel tab, ApiClient api,
        HttpClient agent, ActionName name)
    {
        var command = tab.Sections.SelectMany(s => s.Actions).Single(a => a.Catalogue.Action == name).InvokeCommand;
        Assert.True(command.CanExecute(null));
        await command.ExecuteAsync(null);
        var queued = tab.ActionHistory.First();
        Assert.Equal(ActionRequestStatus.Approved, queued.Request.Status);
        using var response = await agent.GetAsync("/api/agent/actions");
        response.EnsureSuccessStatusCode();
        var request = Assert.Single((await response.Content.ReadFromJsonAsync<ActionRequestDto[]>(AgentJson.SerializerOptions))!);
        Assert.Equal(queued.Request.Id, request.Id);
        Assert.Equal(name, request.Action);
        Assert.Equal(ActionRequestStatus.Dispatched, (await api.GetActionAsync(request.Id, default)).Status);
        return request;
    }

    private static async Task CompleteAsync(MachineTabViewModel tab, ApiClient api, HttpClient agent,
        ActionRequestDto request, ActionOutcome outcome)
    {
        var completed = DateTimeOffset.UtcNow;
        using var response = await agent.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
        {
            RequestId = request.Id, Status = outcome.Status, Output = outcome.Output,
            CollectedData = outcome.CollectedData, CompletedAtUtc = completed
        }, AgentJson.SerializerOptions);
        response.EnsureSuccessStatusCode();
        var stored = await api.GetActionAsync(request.Id, default);
        Assert.Equal(ActionRequestStatus.Completed, stored.Status);
        Assert.Equal(outcome.Status, stored.ResultStatus);
        Assert.Equal(outcome.CollectedData, stored.CollectedData);
        await tab.RefreshCommand.ExecuteAsync(null);
        Assert.Null(tab.ErrorMessage);
        Assert.Equal(outcome.Output, tab.ActionHistory.Single(a => a.Request.Id == request.Id).ResultOutput);
    }


    [Fact]
    public async Task Supervisor_filter_editor_carries_error_provider_and_event_identity_to_executor()
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var section = tab.EventLogs;
            section.NewChannelName = "Synthetic/Application";
            section.NewViewName = "Synthetic exact errors";
            section.NewViewReason = "Synthetic operator-selected error filter";
            section.NewMinimumLevel = EventLogLevel.Error;
            section.NewProviderName = "SyntheticProvider";
            section.NewEventId = "9001";
            Assert.True(section.SaveChannelViewCommand.CanExecute(null));
            await section.SaveChannelViewCommand.ExecuteAsync(null);
            Assert.Equal(EventLogLevel.Error, section.SelectedView!.MinimumLevel);
            Assert.Equal(new[] { "SyntheticProvider" }, section.SelectedView.Sources);
            Assert.Equal(new[] { 9001 }, section.SelectedView.EventIds);
            var request = await DispatchAsync(tab, api, agent, ActionName.RunEventLogView);
            var definition = JsonSerializer.Deserialize<EventLogViewDefinition>(request.Parameters[ActionParameterKeys.EventLogViewDefinition], AgentJson.SerializerOptions)!;
            Assert.Equal(EventLogLevel.Error, definition.MinimumLevel);
            Assert.Equal(new[] { "SyntheticProvider" }, definition.Sources);
            Assert.Equal(new[] { 9001 }, definition.EventIds);
        }
    }

    [Fact]
    public async Task Supervisor_channel_picker_saves_selects_and_really_submits_exact_channel()
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            // Bootstrap discovery through the same authenticated read/report path the UI uses.
            var discoveryRequest = await DispatchAsync(tab, api, agent, ActionName.RunEventLogView);
            var discoveryReader = new EventLogReader(NullLogger<EventLogReader>.Instance,
                new NativeEventChannelReaderTests.Channels(), records: new NativeEventChannelReaderTests.Records());
            var discoveryOutcome = await new RunEventLogViewExecutor(discoveryReader, NullLogger<RunEventLogViewExecutor>.Instance)
                .ExecuteAsync(discoveryRequest, default);
            await CompleteAsync(tab, api, agent, discoveryRequest, discoveryOutcome);
            // The discovery grid's actual SelectedItem feeds the native channel field.
            tab.EventLogs.SelectedChannel = Assert.Single(tab.EventLogs.Channels, c => c.Name == "Vendor/Newer");
            tab.EventLogs.NewViewName = $"UI native {Guid.NewGuid():N}";
            tab.EventLogs.NewViewReason = "Synthetic selected channel browsing";
            Assert.Equal("Vendor/Newer", tab.EventLogs.NewChannelName);
            Assert.True(tab.EventLogs.SaveChannelViewCommand.CanExecute(null));
            await tab.EventLogs.SaveChannelViewCommand.ExecuteAsync(null);
            Assert.Equal(new[] { "Vendor/Newer" }, tab.EventLogs.SelectedView!.ChannelNames);
            Assert.Contains("saved", tab.EventLogs.ViewCreationStatus, StringComparison.OrdinalIgnoreCase);
            var request = await DispatchAsync(tab, api, agent, ActionName.RunEventLogView);
            var definition = JsonSerializer.Deserialize<EventLogViewDefinition>(request.Parameters[ActionParameterKeys.EventLogViewDefinition], AgentJson.SerializerOptions)!;
            Assert.Equal(new[] { "Vendor/Newer" }, definition.ChannelNames);
            Assert.Empty(definition.LogNames);
            var gateway = new NativeEventChannelReaderTests.Records();
            var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, new NativeEventChannelReaderTests.Channels(), records: gateway);
            var outcome = await new RunEventLogViewExecutor(reader, NullLogger<RunEventLogViewExecutor>.Instance).ExecuteAsync(request, default);
            await CompleteAsync(tab, api, agent, request, outcome);
            Assert.Equal(new[] { "Vendor/Newer" }, gateway.Queried);
            Assert.All(tab.EventLogs.Entries, e => Assert.Equal("Vendor/Newer", e.DisplayChannelName));
            Assert.NotEmpty(tab.EventLogs.Entries);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_saved_view_executor_outcomes_survive_authenticated_http_and_console_refresh(bool allUnavailable)
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            // Use the actual authenticated create endpoint, not seeded action results.
            var (supervisorApi, _) = _host.CreateConsole();
            var username = $"native-super-{Guid.NewGuid():N}";
            await _host.CreateUserAsync(Role.Supervisor, username);
            var login = await supervisorApi.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
            using var client = _host.CreateClient();
            client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", login.AccessToken);
            using var created = await client.PostAsJsonAsync("/api/event-log-views", new CreateEventLogViewRequest
            {
                DisplayName = $"Native-{Guid.NewGuid():N}", ChannelNames = allUnavailable
                    ? new[] { "Vendor/Denied", "Vendor/Missing" } : new[] { "Vendor/Newer", "Vendor/Denied", "Vendor/Missing" },
                Reason = "Synthetic integration view", MinimumLevel = EventLogLevel.Verbose, MaximumEntries = 2
            }, AgentJson.SerializerOptions);
            created.EnsureSuccessStatusCode();
            var view = (await created.Content.ReadFromJsonAsync<EventLogViewDto>(AgentJson.SerializerOptions))!;
            tab.EventLogs.ApplyViews(new[] { view });
            var request = await DispatchAsync(tab, api, agent, ActionName.RunEventLogView);
            var gateway = new NativeEventChannelReaderTests.Records();
            var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, new NativeEventChannelReaderTests.Channels(), records: gateway);
            var outcome = await new RunEventLogViewExecutor(reader, NullLogger<RunEventLogViewExecutor>.Instance).ExecuteAsync(request, default);
            Assert.Equal(ActionStatus.Succeeded, outcome.Status);
            var result = JsonSerializer.Deserialize<EventLogViewResultDto>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
            Assert.NotNull(result.ChannelReads);
            Assert.Equal(allUnavailable ? 2 : 3, result.ChannelReads.Count);
            await CompleteAsync(tab, api, agent, request, outcome);
            Assert.Equal(allUnavailable ? Array.Empty<string>() : new[] { "Vendor/Newer", "Vendor/Newer" }, tab.EventLogs.Entries.Select(e => e.DisplayChannelName));
            Assert.Contains("access denied", tab.EventLogs.ResultSummary, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("unavailable", tab.EventLogs.ResultSummary, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("incomplete", tab.EventLogs.ResultSummary, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("not disclosed", outcome.CollectedData!);
        }
    }
}
