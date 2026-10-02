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
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Agent.Tests;

// The native source is synthetic; action creation, dispatch, result ingestion and
// cabinet-bound projection all pass through the real authenticated server host.
public sealed class WerMetadataTransportHost : ConsoleTestHost
{
    protected override bool EnableMaintenanceActions => false;
}

public sealed class WerMetadataTransportTests(WerMetadataTransportHost host) : IClassFixture<WerMetadataTransportHost>
{
    [Fact]
    public async Task Executor_wire_is_accepted_and_pinned_projection_exposes_only_bounded_metadata()
    {
        var observed = DateTimeOffset.UtcNow;
        var reportId = Guid.NewGuid();
        var cabinet = await host.CreateCabinetAsync($"WER-{Guid.NewGuid():N}");
        var foreign = await host.CreateCabinetAsync($"WER-OTHER-{Guid.NewGuid():N}");
        var username = $"wer-staff-{Guid.NewGuid():N}";
        await host.CreateUserAsync(Role.Tier1, username);
        using var staff = host.CreateClient();
        using var signedIn = await staff.PostAsJsonAsync("/api/auth/login",
            new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, AgentJson.SerializerOptions);
        signedIn.EnsureSuccessStatusCode();
        var login = (await signedIn.Content.ReadFromJsonAsync<LoginResponse>(AgentJson.SerializerOptions))!;
        staff.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);

        using var created = await staff.PostAsJsonAsync("/api/actions", new CreateActionRequest
        {
            CabinetId = cabinet.Id, Action = ActionName.GetWerMetadata,
            Reason = "Synthetic read-only WER observation"
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
        Assert.Equal(ActionName.GetWerMetadata, request.Action);
        Assert.Empty(request.Parameters);

        var gateway = new SyntheticGateway(reportId, observed.AddMinutes(-2));
        var outcome = await new GetWerMetadataExecutor(gateway, new FixedClock(observed)).ExecuteAsync(request, default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.NotNull(outcome.CollectedData);
        Assert.Equal(new[] { WerStore.MachineQueue, WerStore.MachineArchive }, gateway.ReadStores);
        // This is the executor's JSON, not a hand-built contract fixture. In particular
        // the Server validator requires named enum strings; numeric drift fails ingestion.
        using var wire = JsonDocument.Parse(outcome.CollectedData);
        Assert.Equal("MachineQueue", wire.RootElement.GetProperty("stores")[0].GetProperty("store").GetString());
        Assert.Equal("Read", wire.RootElement.GetProperty("stores")[0].GetProperty("status").GetString());

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
            Assert.Null(saved.ResultOutput); // WER discards even the Agent's fixed display text.
        }

        var path = $"/api/cabinets/{cabinet.Id}/wer-metadata/{actionId}";
        using var read = await staff.GetAsync(path);
        read.EnsureSuccessStatusCode();
        var body = await read.Content.ReadAsStringAsync();
        using var projection = JsonDocument.Parse(body);
        var root = projection.RootElement;
        Assert.Equal(cabinet.Id, root.GetProperty("cabinetId").GetGuid());
        Assert.Equal(actionId, root.GetProperty("actionId").GetGuid());
        Assert.Equal("complete", root.GetProperty("state").GetString());
        Assert.Equal(completed, root.GetProperty("completedAtUtc").GetDateTimeOffset());
        var metadata = root.GetProperty("metadata");
        Assert.Equal(observed, metadata.GetProperty("observedUtc").GetDateTimeOffset());
        var report = Assert.Single(metadata.GetProperty("reports").EnumerateArray());
        Assert.Equal(reportId, report.GetProperty("reportId").GetGuid());
        Assert.Equal(observed.AddMinutes(-2), report.GetProperty("createdUtc").GetDateTimeOffset());
        Assert.Equal("APPCRASH", report.GetProperty("eventType").GetString());
        Assert.Equal("MachineQueue", report.GetProperty("store").GetString());
        Assert.Equal(2, metadata.GetProperty("stores").GetArrayLength());
        Assert.False(root.TryGetProperty("output", out _));
        Assert.DoesNotContain("private-signature", body, StringComparison.Ordinal);
        Assert.DoesNotContain("private-filename", body, StringComparison.Ordinal);
        Assert.DoesNotContain("private-key", body, StringComparison.Ordinal);
        Assert.DoesNotContain("private-error", body, StringComparison.Ordinal);
        Assert.DoesNotContain("cause", body, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.NotFound, (await staff.GetAsync($"/api/cabinets/{foreign.Id}/wer-metadata/{actionId}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.CreateClient().GetAsync(path)).StatusCode);
    }

    private sealed class FixedClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow => now;
    }

    private sealed class SyntheticGateway(Guid id, DateTimeOffset created) : IWerMetadataGateway
    {
        public List<WerStore> ReadStores { get; } = [];
        public IEnumerable<NativeWerMetadata> Enumerate(WerStore store, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadStores.Add(store);
            if (store == WerStore.MachineQueue)
            {
                yield return new NativeWerMetadata(id, created, "APPCRASH");
                yield return new NativeWerMetadata(Guid.NewGuid(), created, "private-signature private-filename private-key private-error");
            }
        }
    }
}
