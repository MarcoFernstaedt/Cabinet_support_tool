using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Controllers;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Agent.Tests;

// Only the native Security records are synthetic. Every transport step uses the
// real Agent serializer and the authenticated Server host.
public sealed class HistoricalProcessEvidenceTransportHost : ConsoleTestHost
{
    protected override bool EnableMaintenanceActions => false;
}

public sealed class HistoricalProcessEvidenceTransportTests(HistoricalProcessEvidenceTransportHost host)
    : IClassFixture<HistoricalProcessEvidenceTransportHost>
{
    [Fact]
    public async Task Agent_json_round_trips_through_authenticated_dispatch_and_pinned_projection()
    {
        var observed = DateTimeOffset.UtcNow.ToUniversalTime();
        var cabinet = await host.CreateCabinetAsync($"HISTORY-{Guid.NewGuid():N}");
        var other = await host.CreateCabinetAsync($"HISTORY-OTHER-{Guid.NewGuid():N}");
        var username = $"history-staff-{Guid.NewGuid():N}";
        await host.CreateUserAsync(Role.Tier1, username);
        using var staff = host.CreateClient();
        using var loginResponse = await staff.PostAsJsonAsync("/api/auth/login",
            new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, AgentJson.SerializerOptions);
        loginResponse.EnsureSuccessStatusCode();
        var login = (await loginResponse.Content.ReadFromJsonAsync<LoginResponse>(AgentJson.SerializerOptions))!;
        staff.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);

        using var created = await staff.PostAsJsonAsync("/api/actions", new CreateActionRequest
        {
            CabinetId = cabinet.Id, Action = ActionName.GetHistoricalProcessEvidence,
            Reason = "Synthetic historical lifecycle observation"
        }, AgentJson.SerializerOptions);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var creation = JsonDocument.Parse(await created.Content.ReadAsStringAsync());
        var actionId = creation.RootElement.GetProperty("id").GetGuid();
        Assert.Equal("Approved", creation.RootElement.GetProperty("status").GetString());

        using var agent = host.CreateClient();
        agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
        agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", cabinet.MachineId);
        using var dispatched = await agent.GetAsync("/api/agent/actions");
        dispatched.EnsureSuccessStatusCode();
        var request = Assert.Single((await dispatched.Content.ReadFromJsonAsync<ActionRequestDto[]>(AgentJson.SerializerOptions))!);
        Assert.Equal(actionId, request.Id);
        Assert.Equal(cabinet.Id, request.CabinetId);
        Assert.Equal(ActionName.GetHistoricalProcessEvidence, request.Action);
        Assert.Empty(request.Parameters);

        var gateway = new SyntheticSecurityGateway(observed);
        var outcome = await new GetHistoricalProcessEvidenceExecutor(gateway, new FixedClock(observed))
            .ExecuteAsync(request, default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.Equal(1, gateway.Reads);
        Assert.NotNull(outcome.CollectedData);
        using (var wire = JsonDocument.Parse(outcome.CollectedData))
        {
            Assert.Equal("Read", wire.RootElement.GetProperty("status").GetString());
            Assert.False(wire.RootElement.GetProperty("auditCoverageVerified").GetBoolean());
            var events = wire.RootElement.GetProperty("events");
            Assert.Equal("Start", events[0].GetProperty("kind").GetString());
            Assert.Equal(71, events[0].GetProperty("recordId").GetInt64());
            Assert.Equal("Exit", events[1].GetProperty("kind").GetString());
            Assert.Equal(JsonValueKind.Null, events[1].GetProperty("recordId").ValueKind);
        }

        var completed = observed.AddSeconds(1);
        using var reported = await agent.PostAsJsonAsync("/api/agent/actions/result", new ActionResultDto
        {
            RequestId = request.Id, Status = outcome.Status, Output = outcome.Output,
            CollectedData = outcome.CollectedData, CompletedAtUtc = completed
        }, AgentJson.SerializerOptions);
        Assert.Equal(HttpStatusCode.NoContent, reported.StatusCode);
        using (var scope = host.Services.CreateScope())
        {
            var saved = await scope.ServiceProvider.GetRequiredService<SupportDbContext>()
                .ActionRequests.AsNoTracking().SingleAsync(a => a.Id == actionId);
            Assert.Equal(ActionRequestStatus.Completed, saved.Status);
            Assert.Equal(outcome.CollectedData, saved.CollectedDataJson);
            Assert.Null(saved.ResultOutput);
        }

        var path = $"/api/cabinets/{cabinet.Id}/historical-process-evidence/{actionId}";
        using var read = await staff.GetAsync(path);
        read.EnsureSuccessStatusCode();
        var body = await read.Content.ReadAsStringAsync();
        var projection = JsonSerializer.Deserialize<HistoricalProcessSavedResult>(body, AgentJson.SerializerOptions)!;
        Assert.Equal(cabinet.Id, projection.CabinetId);
        Assert.Equal(actionId, projection.ActionId);
        Assert.Equal("complete", projection.State);
        Assert.Equal(completed, projection.CompletedAtUtc);
        var evidence = Assert.IsType<HistoricalProcessEvidenceResult>(projection.Evidence);
        Assert.Equal(observed, evidence.ObservedUtc);
        Assert.Equal(observed.AddDays(-1), evidence.WindowStartUtc);
        Assert.Equal(ProcessEvidenceStatus.Read, evidence.Status);
        Assert.False(evidence.AuditCoverageVerified);
        Assert.False(evidence.Truncated);
        Assert.Collection(evidence.Events,
            start =>
            {
                Assert.Equal(observed.AddHours(-2), start.OccurredUtc);
                Assert.Equal(ProcessEventKind.Start, start.Kind);
                Assert.Equal(26u, start.ProcessId);
                Assert.Equal(71L, start.RecordId);
            },
            exit =>
            {
                Assert.Equal(observed.AddMinutes(-1), exit.OccurredUtc);
                Assert.Equal(ProcessEventKind.Exit, exit.Kind);
                Assert.Equal(26u, exit.ProcessId);
                Assert.Null(exit.RecordId);
            });
        Assert.DoesNotContain("private-path", outcome.CollectedData! + body, StringComparison.Ordinal);
        Assert.DoesNotContain("private-account", outcome.CollectedData! + body, StringComparison.Ordinal);
        Assert.DoesNotContain("private-command", outcome.CollectedData! + body, StringComparison.Ordinal);
        Assert.DoesNotContain("cause", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("present", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("running", body, StringComparison.OrdinalIgnoreCase);
        using var projectionJson = JsonDocument.Parse(body);
        Assert.False(projectionJson.RootElement.TryGetProperty("output", out _));
        Assert.Equal(HttpStatusCode.NotFound,
            (await staff.GetAsync($"/api/cabinets/{other.Id}/historical-process-evidence/{actionId}")).StatusCode);
        using var anonymous = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(path)).StatusCode);
    }

    private sealed class FixedClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow => now;
    }

    private sealed class SyntheticSecurityGateway(DateTimeOffset observed) : IHistoricalProcessGateway
    {
        public int Reads { get; private set; }
        public IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token)
        {
            Reads++;
            Assert.Equal(observed.AddDays(-1), since);
            Assert.Equal(observed, until);
            token.ThrowIfCancellationRequested();
            yield return new NativeProcessEvent(4688, "Microsoft-Windows-Security-Auditing", observed.AddHours(-2),
                "<Event><EventData><Data Name='NewProcessId'>0x1a</Data><Data Name='NewProcessName'>C:\\private-path\\app.exe</Data><Data Name='SubjectUserName'>private-account</Data><Data Name='CommandLine'>private-command --token</Data></EventData></Event>", 71);
            yield return new NativeProcessEvent(4689, "Microsoft-Windows-Security-Auditing", observed.AddMinutes(-1),
                "<Event><EventData><Data Name='ProcessId'>26</Data><Data Name='ProcessName'>C:\\private-path\\app.exe</Data><Data Name='SubjectUserName'>private-account</Data><Data Name='CommandLine'>private-command</Data></EventData></Event>", null);
        }
    }
}
