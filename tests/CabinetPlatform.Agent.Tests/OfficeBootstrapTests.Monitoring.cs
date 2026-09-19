using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Connectivity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace CabinetPlatform.Agent.Tests;

public sealed partial class OfficeBootstrapTests
{
    // Called after real one-use enrollment, supervisor approval and agent restart,
    // including the case where the first exchange response was lost after commit.
    private static async Task VerifyOfficeMonitoringAsync(IServiceProvider server, ServiceProvider agent,
        HttpClient supervisor, ApiClient api, SessionStore session, Guid cabinetId, string root,
        Func<HttpClient> unauthenticatedClient)
    {
        Assert.IsType<OfficeAgentCredentialProvider>(agent.GetRequiredService<IAgentCredentialProvider>());
        Assert.Contains(agent.GetServices<IHostedService>(), worker => worker is ConnectivityWorker);
        Assert.Contains(agent.GetServices<IActionExecutor>(), executor => executor is InspectFirewallExecutor);
        Cabinet target;
        using (var scope = server.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var source = (await db.Cabinets.FindAsync(cabinetId))!;
            // Only the passive probe target is fixture-seeded. The observing agent
            // above must enroll and be approved through the actual HTTP workflow.
            target = new Cabinet
            {
                MachineId = "office-passive-sync", Hostname = "LAB-SYNC", SiteId = source.SiteId,
                Role = CabinetRole.Sync, ApprovedByUserId = source.ApprovedByUserId,
                ApprovedUtc = DateTimeOffset.UtcNow, IsActive = true
            };
            db.Cabinets.Add(target);
            await db.SaveChangesAsync();
        }
        using var configured = await supervisor.PutAsJsonAsync($"/api/connectivity/cabinets/{cabinetId}/targets", new
        {
            reason = "Synthetic office integration", targets = new[] { new { cabinetId = target.Id, address = "192.168.50.20" } }
        });
        configured.EnsureSuccessStatusCode();
        // Use the production DI client with the Office credential handler. Never
        // bypass it with the shared-key fixture helper used in the isolated lanes.
        using var http = agent.GetRequiredService<IHttpClientFactory>().CreateClient(AgentHttpClients.Server);
        var plan = (await http.GetFromJsonAsync<ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
        Assert.Equal(target.Id, Assert.Single(plan.Targets).CabinetId);
        var spoolPath = Path.Combine(root, "combined-outbox");
        var spool = new ConnectivitySpool(spoolPath);
        var start = DateTimeOffset.UtcNow.AddMinutes(-6);
        var sampler = new ConnectivitySampler(cabinetId, new ConnectivitySamplerTests.SequenceProbe(
            ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply,
            ProbeObservation.Reply, ProbeObservation.Reply, ProbeObservation.Reply),
            summary => spool.Enqueue(summary, DateTimeOffset.UtcNow));
        sampler.ApplyPlan(plan with { IssuedUtc = start, ExpiresUtc = start.AddMinutes(10) }, start);
        for (var i = 0; i < 3; i++) await sampler.SampleAsync(start.AddMinutes(i), default);
        var reopened = new ConnectivitySpool(spoolPath);
        Assert.Single(reopened.Peek(DateTimeOffset.UtcNow));
        var delivery = new ConnectivityDelivery(http, reopened, sampler);
        Assert.True(await delivery.DeliverAsync(DateTimeOffset.UtcNow, default));
        Assert.Empty(reopened.Peek(DateTimeOffset.UtcNow));
        var observed = await api.GetConnectivityAsync(cabinetId, default);
        Assert.True(Assert.Single(observed.Links).IncidentOpen);
        Assert.Equal(3, Assert.Single(observed.RecentEvidence).Summary.FailureCount);
        var announcer = new RecordingLiveRegionAnnouncer();
        var tab = new MachineTabViewModel(api,
            new ActionInvoker(api, ScriptedActionDialog.Accepting("Synthetic office inspection"), announcer, session),
            session, announcer, TimeProvider.System);
        await tab.LoadAsync(cabinetId);
        Assert.Contains("Unreachable", Assert.Single(tab.ConnectivityRows));

        var transport = agent.GetRequiredService<IServerClient>();
        async Task<ActionRequestDto> Dispatch()
        {
            var command = tab.Sections.SelectMany(section => section.Actions)
                .Single(action => action.Catalogue.Action == ActionName.InspectFirewall).InvokeCommand;
            Assert.True(command.CanExecute(null));
            await command.ExecuteAsync(null);
            var request = Assert.Single(await transport.GetPendingActionsAsync(cabinetId, default));
            Assert.Equal(ActionName.InspectFirewall, request.Action);
            return request;
        }
        async Task Complete(ActionRequestDto request, IFirewallGateway native)
        {
            var outcome = await new InspectFirewallExecutor(new FirewallReader(native)).ExecuteAsync(request, default);
            Assert.True(await transport.ReportActionResultAsync(new ActionResultDto
            {
                RequestId = request.Id, Status = outcome.Status, Output = outcome.Output,
                CollectedData = outcome.CollectedData, CompletedAtUtc = DateTimeOffset.UtcNow
            }, default));
            var stored = await api.GetActionAsync(request.Id, default);
            Assert.Equal(ActionRequestStatus.Completed, stored.Status);
            Assert.Equal(outcome.CollectedData, stored.CollectedData);
            await tab.RefreshCommand.ExecuteAsync(null);
            Assert.Null(tab.ErrorMessage);
        }
        var request = await Dispatch();
        var deviceKey = agent.GetRequiredService<IAgentCredentialProvider>().GetAgentKey();
        Assert.False(string.IsNullOrWhiteSpace(deviceKey));
        // A valid source key with a different presented machine cannot read plans,
        // upload evidence, dispatch actions or forge an inspection completion.
        using (var forged = unauthenticatedClient())
        {
            forged.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", deviceKey);
            forged.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", target.MachineId);
            using var deniedPlan = await forged.GetAsync("/api/agent/connectivity/plan");
            Assert.Equal(HttpStatusCode.Unauthorized, deniedPlan.StatusCode);
            using var deniedEvidence = await forged.PostAsJsonAsync("/api/agent/connectivity/summaries",
                observed.RecentEvidence.Select(e => e.Summary).ToArray(), AgentJson.SerializerOptions);
            Assert.Equal(HttpStatusCode.Unauthorized, deniedEvidence.StatusCode);
            using var deniedActions = await forged.GetAsync("/api/agent/actions");
            Assert.Equal(HttpStatusCode.Unauthorized, deniedActions.StatusCode);
            using var deniedResult = await forged.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
            {
                RequestId = request.Id, Status = ActionStatus.Succeeded, Output = "forged",
                CollectedData = "{}", CompletedAtUtc = DateTimeOffset.UtcNow
            }, AgentJson.SerializerOptions);
            Assert.Equal(HttpStatusCode.Unauthorized, deniedResult.StatusCode);
            Assert.Equal(ActionRequestStatus.Dispatched, (await api.GetActionAsync(request.Id, default)).Status);
        }
        using (var shared = unauthenticatedClient())
        {
            shared.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
            shared.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", "office-agent-a");
            using var denied = await shared.GetAsync("/api/agent/connectivity/plan");
            Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
            using var deniedActions = await shared.GetAsync("/api/agent/actions");
            Assert.Equal(HttpStatusCode.Unauthorized, deniedActions.StatusCode);
        }
        await Complete(request, new FirewallReaderTests.Native());
        Assert.Equal(128, tab.Firewall.Rules.Count);
        Assert.Equal(3, tab.Firewall.Profiles.Count);
        Assert.Contains("truncated", tab.Firewall.ResultSummary);
        Assert.Contains("OFF", tab.Firewall.RepairStatus);
        for (var i = 3; i < 6; i++) await sampler.SampleAsync(start.AddMinutes(i), default);
        Assert.True(await delivery.DeliverAsync(DateTimeOffset.UtcNow, default));
        observed = await api.GetConnectivityAsync(cabinetId, default);
        Assert.False(Assert.Single(observed.Links).IncidentOpen);
        Assert.Equal(2, observed.RecentEvidence.Count);
        await Complete(await Dispatch(), new OfficeDeniedFirewallGateway());
        Assert.Empty(tab.Firewall.Rules);
        Assert.Contains("AccessDenied", tab.Firewall.ResultSummary);
        Assert.DoesNotContain("Last successful InspectFirewall", tab.ActionHistoryNote);
        Assert.Contains("Reachable", Assert.Single(tab.ConnectivityRows));
    }

    private sealed class OfficeDeniedFirewallGateway : IFirewallGateway
    {
        public IFirewallSession Open() => throw new UnauthorizedAccessException("Synthetic denied native read");
    }
}
