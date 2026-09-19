using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Tests;

public sealed partial class TwoSiteOfficeDemoTests
{
    private static async Task DemonstrateDiagnostics(MachineTabViewModel tab, ApiClient api,
        IServerClient transport, Device source, List<object> steps)
    {
        Assert.Equal("Not reported", tab.Performance.CpuPercent);
        Assert.Equal("92%", tab.Performance.RamUsedPercent);
        Assert.Equal(source.Address, Assert.Single(Assert.Single(tab.Network.Adapters).IpAddresses!));
        Assert.Empty(tab.Disk.Drives);
        Assert.False(tab.Disk.SmartAvailability.HasData);
        var detail = await api.GetCabinetLatestAsync(source.Id, default);
        Assert.True(detail.LatestHeartbeat!.CollectedAtUtc < DateTimeOffset.UtcNow.AddMinutes(-15));
        Assert.Null(detail.LatestHeartbeat.CpuPercent);
        steps.Add(new { stage = "Historical inventory", cabinet = source.Name, cpu = tab.Performance.CpuPercent,
            ram = tab.Performance.RamUsedPercent, address = source.Address,
            smart = tab.Disk.SmartAvailability.Reason, collectedMst = detail.LatestHeartbeat.CollectedAtUtc.ToOffset(TimeSpan.FromHours(-7)).ToString("yyyy-MM-dd HH:mm:ss 'MST'"),
            interpretation = "20-minute-old synthetic measurement, not current state; one high RAM sample is not a sustained trend" });
        async Task<ActionRequestDto> Dispatch(ActionName name)
        {
            var command = tab.Sections.SelectMany(s => s.Actions).Single(a => a.Catalogue.Action == name).InvokeCommand;
            Assert.True(command.CanExecute(null));
            await command.ExecuteAsync(null);
            var request = Assert.Single(await transport.GetPendingActionsAsync(source.Id, default));
            Assert.Equal(source.Id, request.CabinetId);
            Assert.Equal(name, request.Action);
            Assert.Equal(ActionRequestStatus.Dispatched, (await api.GetActionAsync(request.Id, default)).Status);
            return request;
        }
        async Task Complete(ActionRequestDto request, IActionExecutor executor)
        {
            var outcome = await executor.ExecuteAsync(request, default);
            Assert.True(await transport.ReportActionResultAsync(new ActionResultDto
            {
                RequestId = request.Id, Status = outcome.Status, Output = outcome.Output,
                CollectedData = outcome.CollectedData, CompletedAtUtc = DateTimeOffset.UtcNow
            }, default));
            var saved = await api.GetActionAsync(request.Id, default);
            Assert.Equal(ActionRequestStatus.Completed, saved.Status);
            Assert.Equal(outcome.Status, saved.ResultStatus);
            Assert.Equal(outcome.CollectedData, saved.CollectedData);
            await tab.RefreshCommand.ExecuteAsync(null);
            Assert.Null(tab.ErrorMessage);
        }
        var processes = new GetProcessListExecutor(new PerformanceCollector(new FakeWmiRepository(), new LabProcesses(),
            Options.Create(new AgentOptions { Collection = new CollectionOptions { CpuSampleIntervalMilliseconds = 1 } })), NullLogger<GetProcessListExecutor>.Instance);
        await Complete(await Dispatch(ActionName.GetProcessList), processes);
        Assert.Equal(2, tab.Processes.Processes.Count);
        Assert.Contains(tab.Processes.Processes, p => p.Name == "SIM-lab-app" && p.Memory == "64 MB");
        Assert.Contains(tab.Processes.Processes, p => p.Name == "SIM-inaccessible" && p.Cpu == "Not reported");
        steps.Add(new { stage = "Active process diagnostic", cabinet = source.Name,
            rows = tab.Processes.Processes.Select(p => new { p.Pid, p.Name, p.Cpu, p.Memory }).ToArray(),
            control = "Not enabled by this scenario; no native process was started, stopped or restarted" });
        var view = await api.CreateEventLogViewAsync(new CreateEventLogViewRequest
        {
            DisplayName = "SIM application errors", ChannelNames = new[] { "Synthetic/Application" },
            Sources = new[] { "SyntheticProvider" }, EventIds = new[] { 9001 }, MinimumLevel = EventLogLevel.Error,
            MaximumEntries = 20, Reason = "SIMULATION: error filtering through an authorized saved view"
        }, default);
        tab.EventLogs.ApplyViews((await api.GetEventLogViewsAsync(new EventLogViewQuery { PageSize = 100 }, default)).Items);
        tab.EventLogs.SelectedView = Assert.Single(tab.EventLogs.Views, v => v.Id == view.Id);
        tab.EventLogs.SelectedWindow = tab.EventLogs.WindowChoices.Single(w => w.Hours == 1);
        var records = new LabRecords();
        var eventExecutor = new RunEventLogViewExecutor(new EventLogReader(NullLogger<EventLogReader>.Instance,
            new LabChannels(), records: records), NullLogger<RunEventLogViewExecutor>.Instance);
        await Complete(await Dispatch(ActionName.RunEventLogView), eventExecutor);
        Assert.NotNull(records.Definition);
        Assert.Equal(EventLogLevel.Error, records.Definition.MinimumLevel);
        Assert.Equal(new[] { 9001 }, records.Definition.EventIds);
        Assert.Equal(new[] { "SyntheticProvider" }, records.Definition.Sources);
        Assert.Equal(1, records.Definition.WindowHours);
        Assert.Equal(9001, Assert.Single(tab.EventLogs.Entries).EventId);
        var eventSummary = tab.EventLogs.ResultSummary;
        records.Deny = true;
        await Complete(await Dispatch(ActionName.RunEventLogView), eventExecutor);
        Assert.Empty(tab.EventLogs.Entries);
        Assert.Contains("access denied", tab.EventLogs.ResultSummary, StringComparison.OrdinalIgnoreCase);
        steps.Add(new { stage = "Event Viewer errors", cabinet = source.Name, channel = "Synthetic/Application", provider = "SyntheticProvider",
            eventId = 9001, minimumLevel = "Error", windowHours = 1, successfulRead = eventSummary,
            subsequentDeniedRead = tab.EventLogs.ResultSummary,
            limitation = "Native Windows query execution is injected; this verifies filter propagation and result/error handling, not Windows Event Viewer acceptance" });
        await Complete(await Dispatch(ActionName.InspectFirewall), new InspectFirewallExecutor(new FirewallReader(new FirewallReaderTests.Native())));
        Assert.Equal(3, tab.Firewall.Profiles.Count);
        Assert.Contains("OFF", tab.Firewall.RepairStatus);
        steps.Add(new { stage = "Firewall inspection", cabinet = source.Name, profiles = tab.Firewall.Profiles.Count,
            rules = tab.Firewall.Rules.Count, result = tab.Firewall.ResultSummary, repair = tab.Firewall.RepairStatus,
            limitation = "Injected native COM metadata; no firewall change, effective packet permission or GPO provenance claim" });
    }
    private sealed class LabProcesses : IProcessProvider
    {
        public int ProcessorCount => 1;
        public IReadOnlyList<ProcessSnapshot> GetProcesses() => new[]
        {
            new ProcessSnapshot { Pid = 4101, Name = "SIM-lab-app", WorkingSetBytes = 67108864, TotalProcessorTime = TimeSpan.Zero },
            new ProcessSnapshot { Pid = 4102, Name = "SIM-inaccessible" }
        };
    }
    private sealed class LabChannels : IEventChannelGateway
    {
        public IEnumerable<string> GetChannelNames(CancellationToken ct) => new[] { "Synthetic/Application" };
        public EventChannelAccess Probe(string name, CancellationToken ct) => EventChannelAccess.Readable;
    }
    private sealed class LabRecords : IEventRecordGateway
    {
        public bool Deny { get; set; }
        public EventLogViewDefinition? Definition { get; private set; }
        public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken ct)
        {
            Definition = definition;
            if (Deny) throw new UnauthorizedAccessException("Synthetic access denied");
            yield return new EventLogEntry { ChannelName = channel, Source = "SyntheticProvider", EventId = 9001,
                Level = EventLogLevel.Error, TimeCreatedUtc = DateTimeOffset.UtcNow.AddMinutes(-1), Message = "SIMULATED application error; no customer application accessed" };
        }
    }
}
