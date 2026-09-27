using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Agent.Tests;

public sealed partial class FirewallTransportTests
{
    [Theory]
    [InlineData("oversized-name")]
    [InlineData("name-257")]
    [InlineData("null-row")]
    [InlineData("null-profiles")]
    [InlineData("null-rules")]
    [InlineData("null-text")]
    [InlineData("control-text")]
    [InlineData("format-text")]
    [InlineData("129-rules")]
    [InlineData("duplicate-profile")]
    [InlineData("invalid-profile")]
    [InlineData("invalid-profile-status")]
    [InlineData("invalid-status")]
    [InlineData("invalid-version")]
    [InlineData("missing-observed")]
    [InlineData("future-observed")]
    [InlineData("future-completed")]
    [InlineData("reversed-times")]
    [InlineData("invalid-result-status")]
    [InlineData("oversized-output")]
    [InlineData("oversized-note")]
    [InlineData("oversized-caveat")]
    [InlineData("unknown-property")]
    [InlineData("duplicate-property")]
    [InlineData("empty-object")]
    public async Task Server_rejects_invalid_firewall_result_without_changing_dispatched_row(string kind)
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var request = await DispatchAsync(tab, api, agent, ActionName.InspectFirewall);
            var now = DateTimeOffset.UtcNow;
            var node = JsonSerializer.SerializeToNode(new FirewallInspection
            {
                ObservedUtc = now, Status = FirewallReadStatus.Read,
                Profiles = new[] { new FirewallProfileObservation { Profile = 1, Status = FirewallReadStatus.Read } },
                Rules = new[] { new FirewallRuleObservation { Name = "Synthetic", Direction = 1, Protocol = 6 } }
            }, AgentJson.SerializerOptions)!;
            switch (kind)
            {
                case "oversized-name": node["rules"]![0]!["name"] = new string('X', 2 * 1024 * 1024); break;
                case "name-257": node["rules"]![0]!["name"] = new string('X', 257); break;
                case "null-row": node["rules"]![0] = null; break;
                case "null-profiles": node["profiles"] = null; break;
                case "null-rules": node["rules"] = null; break;
                case "null-text": node["rules"]![0]!["localPorts"] = null; break;
                case "control-text": node["rules"]![0]!["name"] = "unsafe\ntext"; break;
                case "format-text": node["rules"]![0]!["name"] = "unsafe\u202etext"; break;
                case "129-rules": node["rules"] = new JsonArray(Enumerable.Range(0,129).Select(_ => node["rules"]![0]!.DeepClone()).ToArray()); break;
                case "duplicate-profile": ((JsonArray)node["profiles"]!).Add(node["profiles"]![0]!.DeepClone()); break;
                case "invalid-profile": node["profiles"]![0]!["profile"] = 8; break;
                case "invalid-profile-status": node["profiles"]![0]!["status"] = 99; break;
                case "invalid-status": node["status"] = 99; break;
                case "invalid-version": node["version"] = 2; break;
                case "missing-observed": ((JsonObject)node).Remove("observedUtc"); break;
                case "future-observed": node["observedUtc"] = now.AddDays(1); break;
                case "oversized-note": node["note"] = new string('X',1025); break;
                case "oversized-caveat": node["policyCaveat"] = new string('X',1025); break;
                case "unknown-property": node["unboundedFutureField"] = "not accepted"; break;
            }
            var payload = kind == "empty-object" ? "{}" : node.ToJsonString();
            if (kind == "duplicate-property") payload = payload.Insert(1,"\"version\":1,");
            using var response = await agent.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
            {
                RequestId = request.Id, Status = kind == "invalid-result-status" ? (ActionStatus)99 : ActionStatus.Succeeded,
                Output = kind == "oversized-output" ? new string('X',8001) : "Synthetic",
                CollectedData = payload, CompletedAtUtc = kind == "future-completed" ? now.AddDays(1) : now,
                StartedAtUtc = kind == "reversed-times" ? now.AddSeconds(1) : null
            }, AgentJson.SerializerOptions);
            Assert.True(response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.RequestEntityTooLarge,
                $"Invalid {kind} accepted: {response.StatusCode}");
            using var scope = _host.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var stored = await db.ActionRequests.AsNoTracking().SingleAsync(a => a.Id == request.Id);
            Assert.Equal(ActionRequestStatus.Dispatched, stored.Status);
            Assert.Null(stored.CollectedDataJson);
            Assert.Null(stored.ResultOutput);
            Assert.Null(stored.ResultStatus);
            Assert.Null(stored.CompletedUtc);
            Assert.Null(stored.StartedUtc);
        }
    }

    [Fact]
    public async Task Server_accepts_maximum_escaped_firewall_rows_without_truncation()
    {
        var (tab, api, agent, _) = await OpenAsync();
        using (agent)
        {
            var request = await DispatchAsync(tab, api, agent, ActionName.InspectFirewall);
            var text = new string('\u4e00',256);
            var payload = JsonSerializer.Serialize(new FirewallInspection
            {
                ObservedUtc = DateTimeOffset.UtcNow, Status = FirewallReadStatus.Read,
                Profiles = new[] {1,2,4}.Select(p => new FirewallProfileObservation {Profile=p,Status=FirewallReadStatus.Read}).ToArray(),
                Rules = Enumerable.Range(0,128).Select(_ => new FirewallRuleObservation
                { Name=text,LocalPorts=text,RemotePorts=text,LocalAddresses=text,RemoteAddresses=text,Direction=1,Protocol=256 }).ToArray(),
                Note = new string('\u4e00',1024), PolicyCaveat = new string('\u4e00',1024)
            }, AgentJson.SerializerOptions);
            Assert.True(Encoding.UTF8.GetByteCount(payload)>900_000);
            using var response = await agent.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
            {
                RequestId=request.Id,Status=ActionStatus.Succeeded,Output=new string('X',8000),
                CollectedData=payload,CompletedAtUtc=DateTimeOffset.UtcNow
            },AgentJson.SerializerOptions);
            Assert.Equal(HttpStatusCode.NoContent,response.StatusCode);
            Assert.Equal(payload,(await api.GetActionAsync(request.Id,default)).CollectedData);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Server_rejects_oversized_result_body_before_binding_even_without_content_length(bool streamed)
    {
        var (tab, api, agent, _) = await OpenAsync();
        using(agent)
        {
            var request=await DispatchAsync(tab,api,agent,ActionName.InspectFirewall);
            var json=JsonSerializer.Serialize(new {requestId=request.Id,status="Succeeded",completedAtUtc=DateTimeOffset.UtcNow,
                unused=new string('X',4*1024*1024+1)});
            using HttpContent content=streamed ? new StreamContent(new NonSeekable(Encoding.UTF8.GetBytes(json))) : new StringContent(json,Encoding.UTF8,"application/json");
            content.Headers.ContentType=new("application/json");
            using var response=await agent.PostAsync("/api/agent/actions/result",content);
            Assert.Equal(HttpStatusCode.RequestEntityTooLarge,response.StatusCode);
            Assert.Equal(ActionRequestStatus.Dispatched,(await api.GetActionAsync(request.Id,default)).Status);
        }
    }

    private sealed class NonSeekable(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }
}
