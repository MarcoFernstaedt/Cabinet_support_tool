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

public sealed partial class FirewallTransportTests(DiagnosticConsoleTestHost host) : IClassFixture<DiagnosticConsoleTestHost>
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
    public async Task Console_action_native_inspection_report_and_refresh_are_wired_end_to_end()
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var request = await DispatchAsync(tab, api, agent, ActionName.InspectFirewall);
            Assert.Empty(request.Parameters);
            var outcome = await new InspectFirewallExecutor(new FirewallReader(new FirewallReaderTests.Native()))
                .ExecuteAsync(request, default);
            await CompleteAsync(tab, api, agent, request, outcome);
            Assert.Equal(128, tab.Firewall.Rules.Count);
            Assert.Equal(3, tab.Firewall.Profiles.Count);
            Assert.Contains("truncated", tab.Firewall.ResultSummary);
            Assert.Contains("not", tab.Firewall.PolicyCaveat);
            Assert.Contains("OFF", tab.Firewall.RepairStatus);
            // A later native refusal is an explicit unknown result, not stale green data.
            var next = await DispatchAsync(tab, api, agent, ActionName.InspectFirewall);
            var failure = await new InspectFirewallExecutor(new FirewallReader(new DeniedGateway()))
                .ExecuteAsync(next, default);
            await CompleteAsync(tab, api, agent, next, failure);
            Assert.Empty(tab.Firewall.Rules);
            Assert.Contains("AccessDenied", tab.Firewall.ResultSummary);
            Assert.DoesNotContain("Last successful InspectFirewall", tab.ActionHistoryNote);
        }
    }

    [Fact]
    public async Task Inspection_rejects_anonymous_requests_extra_operands_and_foreign_agent_results()
    {
        var (tab, api, agent, cabinet) = await OpenAsync();
        using (agent)
        using (var anonymous = _host.CreateClient())
        {
            using var denied = await anonymous.PostAsJsonAsync("/api/actions", new CreateActionRequest
            {
                CabinetId = cabinet.Id, Action = ActionName.InspectFirewall, Reason = "Synthetic unauthorized read"
            }, AgentJson.SerializerOptions);
            Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
            var invalid = await Assert.ThrowsAsync<ApiException>(() => api.CreateActionAsync(new CreateActionRequest
            {
                CabinetId = cabinet.Id, Action = ActionName.InspectFirewall, Reason = "Synthetic invalid operand",
                Parameters = new Dictionary<string, string> { ["ruleName"] = "*" }
            }, default));
            Assert.NotNull(invalid);
            var request = await DispatchAsync(tab, api, agent, ActionName.InspectFirewall);
            var foreign = await _host.CreateCabinetAsync($"SYNTHETIC-OTHER-{Guid.NewGuid():N}");
            using var other = _host.CreateClient();
            other.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
            other.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", foreign.MachineId);
            using var report = await other.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
            {
                RequestId = request.Id, Status = ActionStatus.Succeeded, Output = "Forged observation",
                CollectedData = "{}", CompletedAtUtc = DateTimeOffset.UtcNow
            }, AgentJson.SerializerOptions);
            Assert.Equal(HttpStatusCode.NotFound, report.StatusCode);
            Assert.Equal(ActionRequestStatus.Dispatched, (await api.GetActionAsync(request.Id, default)).Status);
        }
    }

    [Theory]
    [InlineData("null")]
    [InlineData("{\"version\":1,\"observedUtc\":\"2026-09-19T20:00:00Z\",\"profiles\":[null]}")]
    [InlineData("{\"version\":1,\"observedUtc\":\"2026-09-19T20:00:00Z\",\"rules\":[null]}")]
    [InlineData("{\"version\":2,\"observedUtc\":\"2026-09-19T20:00:00Z\"}")]
    public async Task Malformed_native_result_is_not_applied_through_real_transport(string malformed)
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var request = await DispatchAsync(tab, api, agent, ActionName.InspectFirewall);
            using var response = await agent.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
            {
                RequestId = request.Id, Status = ActionStatus.Succeeded, Output = "Synthetic malformed payload",
                CollectedData = malformed, CompletedAtUtc = DateTimeOffset.UtcNow
            }, AgentJson.SerializerOptions);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var stored = await api.GetActionAsync(request.Id, default);
            Assert.Equal(ActionRequestStatus.Dispatched, stored.Status);
            Assert.Null(stored.CollectedData);
            await tab.RefreshCommand.ExecuteAsync(null);
            Assert.Empty(tab.Firewall.Rules);
            Assert.Empty(tab.Firewall.Profiles);
            Assert.Contains("Unknown", tab.Firewall.ResultSummary);
        }
    }

    private sealed class DeniedGateway : IFirewallGateway
    {
        public IFirewallSession Open() => throw new UnauthorizedAccessException("Never disclose native details");
    }
}
