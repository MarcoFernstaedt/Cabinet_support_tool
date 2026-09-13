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

/// <summary>
/// Synthetic native inputs only. Everything from console submission through the
/// ASP.NET dispatch/result endpoints, agent executor serialization and console
/// refresh is real. No action/status/collected-data rows are seeded in the DB.
/// Kept here because the agent targets net8.0-windows; this suite runs on Linux.
/// </summary>
public sealed class DiagnosticConsoleTestHost : ConsoleTestHost
{
    protected override bool EnableMaintenanceActions => false;
}

public sealed class DiagnosticDemoTests : IClassFixture<DiagnosticConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public DiagnosticDemoTests(DiagnosticConsoleTestHost host) => _host = host;

    private async Task<(MachineTabViewModel Tab, ApiClient Api, HttpClient Agent, Cabinet Cabinet)> OpenAsync()
    {
        var name = $"demo-{Guid.NewGuid():N}";
        await _host.CreateUserAsync(Role.Tier2, name);
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
    public async Task Process_executor_rows_survive_dispatch_result_and_console_refresh()
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var request = await DispatchAsync(tab, api, agent, ActionName.GetProcessList);
            var input = new SyntheticProcesses();
            var collector = new PerformanceCollector(new FakeWmiRepository(), input,
                Options.Create(new AgentOptions { Collection = new CollectionOptions { CpuSampleIntervalMilliseconds = 1 } }));
            var outcome = await new GetProcessListExecutor(collector, NullLogger<GetProcessListExecutor>.Instance)
                .ExecuteAsync(request, default);
            Assert.Equal(ActionStatus.Succeeded, outcome.Status);
            Assert.Equal(2, input.Reads);
            await CompleteAsync(tab, api, agent, request, outcome);
            Assert.Equal(new[] { 4102, 4101, 4103 }, tab.Processes.Processes.Select(p => p.Pid));
            var busy = tab.Processes.Processes[0];
            Assert.Equal("synthetic-busy", busy.Name);
            Assert.Equal(100d, busy.Info.CpuPercent);
            Assert.Equal("100%", busy.Cpu);
            Assert.Equal(134217728L, busy.Info.WorkingSetBytes);
            Assert.Equal("128 MB", busy.Memory);
            Assert.Equal("0%", tab.Processes.Processes[1].Cpu);
            Assert.Equal("Not reported", tab.Processes.Processes[2].Cpu);
            Assert.Equal("Not reported", tab.Processes.Processes[2].Memory);
            Assert.NotNull(tab.Processes.CollectedUtc);
            tab.Processes.SelectedProcess = busy;
            Assert.Equal("4102", tab.Processes.CurrentProcessIdParameters()[ActionParameterKeys.ProcessId]);
            Assert.Equal("synthetic-busy", tab.Processes.CurrentProcessIdParameters()[ActionParameterKeys.ExpectedProcessName]);
            await tab.RefreshActionsCommand.ExecuteAsync(null);
            Assert.Same(busy, tab.Processes.SelectedProcess);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Named_event_view_preserves_records_and_truncation_through_refresh(bool truncated)
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var selected = tab.EventLogs.Views.First();
            tab.EventLogs.SelectedView = selected;
            tab.EventLogs.SelectedWindow = tab.EventLogs.WindowChoices.Single(w => w.Hours == 8);
            var request = await DispatchAsync(tab, api, agent, ActionName.RunEventLogView);
            var reader = new SyntheticEvents(truncated);
            var outcome = await new RunEventLogViewExecutor(reader, NullLogger<RunEventLogViewExecutor>.Instance)
                .ExecuteAsync(request, default);
            Assert.Equal(ActionStatus.Succeeded, outcome.Status);
            Assert.NotNull(reader.Definition);
            Assert.Equal(selected.Id, reader.Definition.ViewId);
            Assert.Equal(selected.DisplayName, reader.Definition.DisplayName);
            Assert.Equal(selected.LogNames, reader.Definition.LogNames);
            Assert.Equal(selected.Sources, reader.Definition.Sources);
            Assert.Equal(selected.EventIds, reader.Definition.EventIds);
            Assert.Equal(8, reader.Definition.WindowHours);
            await CompleteAsync(tab, api, agent, request, outcome);
            Assert.Equal(reader.Entries, tab.EventLogs.Entries);
            Assert.Equal(selected.DisplayName, tab.EventLogs.ResultViewName);
            Assert.Equal(8, tab.EventLogs.ResultWindowHours);
            Assert.Equal(truncated, tab.EventLogs.ResultTruncated);
            Assert.Equal(SyntheticEvents.Timestamp, tab.EventLogs.Entries[0].TimeCreatedUtc);
            Assert.Equal("Synthetic diagnostic message\nsecond line <not markup>", tab.EventLogs.Entries[0].Message);
            Assert.Contains(truncated ? "newest" : "matched 1", tab.EventLogs.ResultSummary);
        }
    }

    [Theory]
    [InlineData(ActionName.GetProcessList, "not-json")]
    [InlineData(ActionName.GetProcessList, "[null]")]
    [InlineData(ActionName.RunEventLogView, "not-json")]
    [InlineData(ActionName.RunEventLogView, "{\"viewId\":\"00000000-0000-0000-0000-000000000001\",\"viewDisplayName\":\"Synthetic\",\"windowHours\":8,\"truncated\":false,\"entries\":null}")]
    [InlineData(ActionName.RunEventLogView, "{\"viewId\":\"00000000-0000-0000-0000-000000000001\",\"viewDisplayName\":\"Synthetic\",\"windowHours\":8,\"truncated\":false,\"entries\":[null]}")]
    public async Task Malformed_collected_data_does_not_crash_refresh_or_render_measurements(ActionName name, string data)
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var request = await DispatchAsync(tab, api, agent, name);
            await CompleteAsync(tab, api, agent, request, ActionOutcome.Collected("Synthetic malformed result", data));
            Assert.Empty(tab.Processes.Processes);
            Assert.Empty(tab.EventLogs.Entries);
            Assert.False(await tab.TryApplyActionResultAsync(request.Id));
        }
    }

    [Fact]
    public async Task Failed_collection_is_visible_in_history_not_an_empty_success()
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var request = await DispatchAsync(tab, api, agent, ActionName.RunEventLogView);
            var outcome = await new RunEventLogViewExecutor(new SyntheticEvents(false, fail: true),
                NullLogger<RunEventLogViewExecutor>.Instance).ExecuteAsync(request, default);
            Assert.Equal(ActionStatus.Failed, outcome.Status);
            await CompleteAsync(tab, api, agent, request, outcome);
            Assert.Equal(ActionStatus.Failed, Assert.Single(tab.ActionHistory).Request.ResultStatus);
            Assert.Contains("Synthetic access denied", Assert.Single(tab.ActionHistory).ResultOutput);
            Assert.Empty(tab.EventLogs.Entries);
            Assert.False(tab.EventLogs.Availability.HasData);
        }
    }

    [Fact]
    public async Task Missing_action_request_returns_real_404_and_visible_console_error()
    {
        var (tab, _, agent, _) = await OpenAsync();
        using (agent)
        {
            Assert.False(await tab.TryApplyActionResultAsync(Guid.NewGuid()));
            Assert.NotNull(tab.ErrorMessage);
            Assert.Empty(tab.Processes.Processes);
            Assert.Empty(tab.EventLogs.Entries);
        }
    }

    [Theory]
    [InlineData(ActionName.GetProcessList, false)]
    [InlineData(ActionName.GetProcessList, true)]
    [InlineData(ActionName.RunEventLogView, false)]
    [InlineData(ActionName.RunEventLogView, true)]
    public async Task Latest_failed_or_unreadable_fetch_keeps_labelled_last_successful_snapshot(ActionName name, bool malformed)
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var first = await DispatchAsync(tab, api, agent, name);
            IActionExecutor executor = name == ActionName.GetProcessList
                ? new GetProcessListExecutor(new PerformanceCollector(new FakeWmiRepository(), new SyntheticProcesses(),
                    Options.Create(new AgentOptions { Collection = new CollectionOptions { CpuSampleIntervalMilliseconds = 1 } })),
                    NullLogger<GetProcessListExecutor>.Instance)
                : new RunEventLogViewExecutor(new SyntheticEvents(false), NullLogger<RunEventLogViewExecutor>.Instance);
            await CompleteAsync(tab, api, agent, first, await executor.ExecuteAsync(first, default));
            var processes = tab.Processes.Processes.Select(p => p.Info).ToArray();
            var events = tab.EventLogs.Entries.ToArray();
            var second = await DispatchAsync(tab, api, agent, name);
            await CompleteAsync(tab, api, agent, second, malformed
                ? ActionOutcome.Collected("Synthetic invalid newer snapshot", "not-json")
                : ActionOutcome.Failed("Synthetic failed newer fetch"));
            Assert.Equal(2, tab.ActionHistory.Count);
            Assert.Equal(processes, tab.Processes.Processes.Select(p => p.Info));
            Assert.Equal(events, tab.EventLogs.Entries);
            Assert.Contains("Last successful", tab.ActionHistoryNote);
            Assert.Contains(first.Id.ToString(), tab.ActionHistoryNote);
            if (malformed) Assert.Contains("unreadable", tab.ActionHistoryNote);
        }
    }

    private sealed class SyntheticProcesses : IProcessProvider
    {
        public int Reads { get; private set; }
        public int ProcessorCount => 1;
        public IReadOnlyList<ProcessSnapshot> GetProcesses()
        {
            Reads++;
            return new[]
            {
                new ProcessSnapshot { Pid = 4101, Name = "synthetic-idle", WorkingSetBytes = 1048576, TotalProcessorTime = TimeSpan.Zero },
                // A deliberately saturating delta avoids depending on scheduler timing.
                new ProcessSnapshot { Pid = 4102, Name = "synthetic-busy", WorkingSetBytes = 134217728,
                    TotalProcessorTime = Reads == 1 ? TimeSpan.Zero : TimeSpan.FromDays(1) },
                new ProcessSnapshot { Pid = 4103, Name = "synthetic-unreadable" }
            };
        }
    }

    private sealed class SyntheticEvents(bool truncated, bool fail = false) : IEventLogReader
    {
        public static readonly DateTimeOffset Timestamp = new(2026, 9, 13, 10, 11, 12, TimeSpan.Zero);
        public EventLogViewDefinition? Definition { get; private set; }
        public IReadOnlyList<EventLogEntry> Entries { get; private set; } = Array.Empty<EventLogEntry>();
        public IReadOnlyList<EventLogEntry> Read(EventLogName log, TimeSpan window, int maximumEntries, CancellationToken cancellationToken)
            => throw new InvalidOperationException("The named view must use RunView, not the legacy collector.");
        public IReadOnlyList<EventLogEntry> RunView(EventLogViewDefinition definition, CancellationToken cancellationToken)
        {
            Definition = definition;
            if (fail) throw new UnauthorizedAccessException("Synthetic access denied");
            Entries = Enumerable.Range(0, truncated ? definition.MaximumEntries : 1).Select(i => new EventLogEntry
            {
                LogName = definition.LogNames.First(), Source = definition.Sources.FirstOrDefault() ?? "SyntheticProvider",
                EventId = definition.EventIds.FirstOrDefault(9001), Level = definition.MinimumLevel,
                TimeCreatedUtc = Timestamp.AddSeconds(-i), Message = "Synthetic diagnostic message\nsecond line <not markup>"
            }).ToArray();
            return Entries;
        }
    }
}
