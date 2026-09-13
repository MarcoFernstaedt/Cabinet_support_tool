using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Tests.Actions;

/// <summary>Real authenticated request/approval/dispatch/result/Console path; all process effects are inert.</summary>
public sealed class SelectedProcessAcceptanceTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public SelectedProcessAcceptanceTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Complete_selected_identity_does_not_bypass_authentication_or_default_diagnostic_mode()
    {
        using var host = new DiagnosticConsoleTestHost();
        var cabinet = await host.CreateCabinetAsync($"DIAGNOSTIC-{Guid.NewGuid():N}");
        var (api, _) = host.CreateConsole();
        var request = new CreateActionRequest
        {
            CabinetId = cabinet.Id, Action = ActionName.KillProcess,
            Reason = "Synthetic complete identity policy check",
            Parameters = new Dictionary<string, string>
            {
                [ActionParameterKeys.ProcessId] = "900", [ActionParameterKeys.ExpectedProcessName] = "notepad",
                [ActionParameterKeys.ExpectedCreationTimeFileTime] = "133700000000000001",
                [ActionParameterKeys.ExpectedExecutablePath] = @"C:\Lab\notepad.exe",
            },
        };
        var unauthenticated = await Assert.ThrowsAsync<ApiException>(() => api.CreateActionAsync(request, default));
        Assert.Equal(ApiFailure.SessionExpired, unauthenticated.Failure);
        string name = $"diagnostic-process-{Guid.NewGuid():N}";
        await host.CreateUserAsync(Role.Supervisor, name);
        await api.LoginAsync(new LoginRequest { Username = name, Password = ConsoleTestHost.KnownPassword }, default);
        Assert.DoesNotContain(await api.GetActionCatalogAsync(default), a => a.Action == ActionName.KillProcess);
        var denied = await Assert.ThrowsAsync<ApiException>(() => api.CreateActionAsync(request, default));
        Assert.Equal(ApiFailure.Invalid, denied.Failure);
        Assert.Equal("Unknown action.", denied.Message); // Diagnostic catalogue deliberately omits mutation.
    }

    [Theory]
    [InlineData("matched", ActionStatus.Succeeded)]
    [InlineData("same-name-replacement", ActionStatus.Denied)]
    [InlineData("missing-identity", ActionStatus.Denied)]
    [InlineData("exact-path", ActionStatus.Succeeded)]
    [InlineData("wait-error", ActionStatus.Failed)]
    [InlineData("timeout", ActionStatus.Failed)]
    [InlineData("diagnostic-agent", ActionStatus.Denied)]
    public async Task Selected_row_reaches_real_executor_and_persisted_visible_result(string scenario, ActionStatus expected)
    {
        string name = $"process-{Guid.NewGuid():N}";
        await _host.CreateUserAsync(Role.Tier2, name);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = name, Password = ConsoleTestHost.KnownPassword }, default);
        var announcer = new RecordingLiveRegionAnnouncer();
        var tab = new MachineTabViewModel(api,
            new ActionInvoker(api, ScriptedActionDialog.Accepting("Synthetic selected process acceptance"), announcer, session),
            session, announcer, TimeProvider.System);
        var cabinet = await _host.CreateCabinetAsync($"SYNTHETIC-{Guid.NewGuid():N}");
        using var agent = _host.CreateClient();
        agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
        agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", cabinet.MachineId);
        using var checkin = await agent.PostAsJsonAsync("/api/agent/checkin", new CheckInPayload
        {
            MachineId = cabinet.MachineId, AgentVersion = "synthetic-process-test", CollectedAtUtc = DateTimeOffset.UtcNow,
            System = new SystemInfo { Hostname = cabinet.Hostname, AnyUserLoggedOn = false, TimeZoneId = "UTC" }
        }, AgentJson.SerializerOptions);
        checkin.EnsureSuccessStatusCode();
        await tab.LoadAsync(cabinet.Id);
        Assert.Null(tab.ErrorMessage);

        var identity = SelectedProcessGatewayTests.Selection with
        {
            ProcessName = "notepad", CreationTimeFileTime = 133700000000000001,
            ExecutablePath = scenario == "exact-path" ? @"\\?\C:\Lab\" + new string('x', 280) + ".exe " : @"C:\Lab\notepad.exe",
        };
        var source = new SyntheticProcesses(scenario == "missing-identity" ? null : identity);
        var collection = new GetProcessListExecutor(new PerformanceCollector(new FakeWmiRepository(), source,
            Options.Create(new AgentOptions { Collection = new CollectionOptions { CpuSampleIntervalMilliseconds = 1 } })),
            NullLogger<GetProcessListExecutor>.Instance);
        var listCommand = tab.Processes.Actions.Single(a => a.Catalogue.Action == ActionName.GetProcessList).InvokeCommand;
        await listCommand.ExecuteAsync(null);
        ActionRequestDto listRequest = Assert.Single((await agent.GetFromJsonAsync<ActionRequestDto[]>("/api/agent/actions", AgentJson.SerializerOptions))!);
        var listOutcome = await collection.ExecuteAsync(listRequest, default);
        await ReportAsync(listRequest.Id, listOutcome.Status, listOutcome.Output, listOutcome.CollectedData);
        var row = Assert.Single(tab.Processes.Processes);
        Assert.Equal(900, row.Pid);
        Assert.Equal("notepad", row.Name);
        tab.Processes.SelectedProcess = row;
        var command = tab.Processes.Actions.Single(a => a.Catalogue.Action == ActionName.KillProcess).InvokeCommand;
        var factory = new SelectedProcessGatewayTests.FakeFactory();
        factory.Handle.Identity = identity;
        var options = new AgentOptions { Actions = new ActionOptions { ExecutionMode = scenario == "diagnostic-agent" ? "DiagnosticOnly" : "Maintenance" } };
        var executor = new KillProcessExecutor(new ProcessControlGateway(factory), ProcessTargetPolicyTests.Policy(["notepad"]),
            Options.Create(options), NullLogger<KillProcessExecutor>.Instance);
        var store = new InMemoryAgentStateStore(new AgentState
        {
            MachineId = cabinet.MachineId, CabinetId = cabinet.Id, RegistrationStatus = RegistrationStatus.Approved,
        });
        var dispatcher = new ActionDispatcher(new ActionExecutorRegistry([executor], NullLogger<ActionExecutorRegistry>.Instance),
            store, new FixedClock(DateTimeOffset.UtcNow), Options.Create(options), NullLogger<ActionDispatcher>.Instance);

        if (scenario == "missing-identity")
        {
            Assert.False(command.CanExecute(null));
            Assert.Empty(tab.Processes.CurrentProcessIdParameters());
            var legacy = new Dictionary<string, string>
            {
                [ActionParameterKeys.ProcessId] = "900", [ActionParameterKeys.ExpectedProcessName] = "notepad",
            };
            var refusal = await Assert.ThrowsAsync<ApiException>(() => api.CreateActionAsync(new CreateActionRequest
            {
                CabinetId = cabinet.Id, Action = ActionName.KillProcess, Reason = "Legacy selected process request", Parameters = legacy,
            }, default));
            Assert.Equal(ApiFailure.Invalid, refusal.Failure);
            var legacyResult = await dispatcher.DispatchAsync(listRequest with { Id = Guid.NewGuid(), Action = ActionName.KillProcess, Parameters = legacy }, default);
            Assert.Equal(ActionStatus.Denied, legacyResult.Status);
            Assert.Equal(0, factory.OpenCount);
            return;
        }

        Assert.True(command.CanExecute(null));
        await command.ExecuteAsync(null);
        var pending = tab.ActionHistory.First().Request;
        Assert.Equal(ActionRequestStatus.PendingApproval, pending.Status);
        Assert.Empty((await agent.GetFromJsonAsync<ActionRequestDto[]>("/api/agent/actions", AgentJson.SerializerOptions))!);
        var selfApproval = await Assert.ThrowsAsync<ApiException>(() => api.ApproveActionAsync(pending.Id, new ApproveActionRequest(), default));
        Assert.Equal(ApiFailure.Forbidden, selfApproval.Failure);
        string approverName = $"approver-{Guid.NewGuid():N}";
        await _host.CreateUserAsync(Role.Supervisor, approverName);
        var (approver, _) = _host.CreateConsole();
        await approver.LoginAsync(new LoginRequest { Username = approverName, Password = ConsoleTestHost.KnownPassword }, default);
        await approver.ApproveActionAsync(pending.Id, new ApproveActionRequest(), default);
        ActionRequestDto request = Assert.Single((await agent.GetFromJsonAsync<ActionRequestDto[]>("/api/agent/actions", AgentJson.SerializerOptions))!);
        Assert.Equal(pending.Id, request.Id);
        Assert.Equal("133700000000000001", request.Parameters[ActionParameterKeys.ExpectedCreationTimeFileTime]);
        Assert.Equal(identity.ExecutablePath, request.Parameters[ActionParameterKeys.ExpectedExecutablePath]);
        if (scenario == "same-name-replacement") factory.Handle.Identity = identity with { CreationTimeFileTime = identity.CreationTimeFileTime + 1 };
        if (scenario == "wait-error") factory.Handle.WaitFailure = new System.ComponentModel.Win32Exception(6);
        if (scenario == "timeout") factory.Handle.Exits = false;
        var result = await dispatcher.DispatchAsync(request, default);
        Assert.Equal(expected, result.Status);
        Assert.Equal(scenario is "matched" or "exact-path" or "wait-error" or "timeout", factory.Handle.Terminated);
        Assert.Equal(scenario == "diagnostic-agent" ? 0 : 1, factory.OpenCount);
        if (scenario is "wait-error" or "timeout")
        {
            Assert.Contains("exit was not confirmed", result.Output);
            Assert.DoesNotContain("could not be ended", result.Output);
            var data = JsonSerializer.Deserialize<ProcessActionResultDto>(result.CollectedData!, AgentJson.SerializerOptions)!;
            Assert.Empty(data.EndedProcessIds);
            using var json = JsonDocument.Parse(result.CollectedData!);
            Assert.True(json.RootElement.GetProperty("terminationRequested").GetBoolean());
            Assert.False(json.RootElement.GetProperty("exitConfirmed").GetBoolean());
        }
        Assert.Equal(expected, Assert.Single(store.Load().CompletedActions).Status);
        await ReportAsync(result.RequestId, result.Status, result.Output, result.CollectedData);
        // Same approved request replays the durable result, not a second native operation.
        Assert.Equal(result, await dispatcher.DispatchAsync(request, default));
        Assert.Equal(scenario == "diagnostic-agent" ? 0 : 1, factory.OpenCount);

        async Task ReportAsync(Guid id, ActionStatus status, string? output, string? data)
        {
            using var report = await agent.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
            {
                RequestId = id, Status = status, Output = output, CollectedData = data, CompletedAtUtc = DateTimeOffset.UtcNow,
            }, AgentJson.SerializerOptions);
            report.EnsureSuccessStatusCode();
            var stored = await api.GetActionAsync(id, default);
            Assert.Equal(ActionRequestStatus.Completed, stored.Status);
            Assert.Equal(status, stored.ResultStatus);
            Assert.Equal(data, stored.CollectedData);
            await tab.RefreshCommand.ExecuteAsync(null);
            Assert.Null(tab.ErrorMessage);
            Assert.Equal(output, tab.ActionHistory.Single(a => a.Request.Id == id).ResultOutput);
        }
    }

    private sealed class SyntheticProcesses(ProcessSelectionIdentity? identity) : IProcessProvider
    {
        public int ProcessorCount => 1;
        public IReadOnlyList<ProcessSnapshot> GetProcesses() => [new ProcessSnapshot
        {
            Pid = 900, Name = "notepad", SelectionIdentity = identity, WorkingSetBytes = 1048576,
        }];
    }
}
