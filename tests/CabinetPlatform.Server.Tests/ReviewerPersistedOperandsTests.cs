using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Server.Tests;

// Original independent R1 probe retained as a durable regression.
public class ReviewerPersistedOperandsTests
{
    public static IEnumerable<object[]> Cases()
    {
        foreach (var mode in new[] { "DiagnosticOnly", "Demo" })
        foreach (var json in new[] { "{}", "null", "not-json", "{\"processId\":\"900\"}", "{\"processId\":null}", "{\"processId\":900}", "{\"processId\":\"900\",\"ProcessId\":\"901\"}" })
            yield return new object[] { mode, json };
    }

    public static IEnumerable<object[]> DuplicateIdentityCases()
    {
        foreach (var mode in new[] { "Demo", "Maintenance" })
        foreach (var key in new[] { "processId", "expectedProcessName", "expectedCreationTimeFileTime", "expectedExecutablePath" })
        foreach (var casing in new[] { key, key.ToUpperInvariant() })
        {
            // Otherwise complete operands ensure a last-value-wins parser would authorize dispatch.
            var identity = new Dictionary<string, string>
            {
                ["processId"] = "900",
                ["expectedProcessName"] = "notepad",
                ["expectedCreationTimeFileTime"] = "133700000000000001",
                ["expectedExecutablePath"] = @"C:\Windows\System32\notepad.exe"
            };
            string json = System.Text.Json.JsonSerializer.Serialize(identity);
            string duplicate = System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, string>
            {
                [casing] = key == "processId" ? "901" : identity[key]
            });
            yield return new object[] { mode, json[..^1] + "," + duplicate[1..] };
        }
    }

    [Theory]
    [MemberData(nameof(DuplicateIdentityCases))]
    public Task Duplicate_persisted_identity_cancels_without_picking_an_operand(string mode, string json) =>
        Invalid_persisted_operands_cancel_without_poisoning_observations(mode, json);

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task Invalid_persisted_operands_cancel_without_poisoning_observations(string mode, string json)
    {
        using var factory = new SupportApiFactory { ExecutionMode = mode };
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "reviewer");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "reviewer", user.Id);
        var invalidId = Guid.NewGuid();
        await factory.WithDbAsync(async db =>
        {
            db.ActionRequests.Add(new CabinetPlatform.Server.Domain.ActionRequest
            {
                Id = invalidId, CabinetId = cabinet.Id, Action = ActionName.KillProcess,
                RequestedByUserId = user.Id, Reason = "Reviewer invalid persisted operands",
                ParametersJson = json, Status = ActionRequestStatus.Approved,
                RequestedUtc = DateTimeOffset.UtcNow.AddMinutes(-1), ExpiresUtc = DateTimeOffset.UtcNow.AddMinutes(10)
            });
            db.ActionRequests.Add(new CabinetPlatform.Server.Domain.ActionRequest
            {
                CabinetId = cabinet.Id, Action = ActionName.GetProcessList,
                RequestedByUserId = user.Id, Reason = "Reviewer observation", ParametersJson = "{}",
                Status = ActionRequestStatus.Approved, RequestedUtc = DateTimeOffset.UtcNow,
                ExpiresUtc = DateTimeOffset.UtcNow.AddMinutes(10)
            });
            await db.SaveChangesAsync();
        });
        using var agent = TestClient.CreateAgentClient(factory, cabinet.MachineId);
        using var response = await agent.GetAsync("/api/agent/actions");
        string body = await response.Content.ReadAsStringAsync();
        string stored = "";
        await factory.WithDbAsync(async db => stored = (await db.ActionRequests.FindAsync(invalidId))!.Status.ToString());
        Assert.True(response.StatusCode == HttpStatusCode.OK,
            $"HTTP {(int)response.StatusCode}; persisted status={stored}; body={body}");
        Assert.Equal("Cancelled", stored);
        Assert.Equal(ActionName.GetProcessList, Assert.Single((await response.Content.ReadFromJsonAsync<List<ActionRequestDto>>(TestClient.Json))!).Action);
    }
}
