using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Registrations;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetNamingTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public CabinetNamingTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Rename_is_supervisor_only_audited_and_preserves_identity()
    {
        var (supervisor, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var body = new { FriendlyName = "  North pharmacy  ", Reason = "Correct label" };
        var response = await supervisor.PatchJsonAsync($"/api/cabinets/{cabinet.Id}/name", body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        foreach (var role in new[] { Role.Tier1, Role.Tier2 })
        {
            var (support, _) = await TestClient.CreateUserClientAsync(_factory, role, Guid.NewGuid().ToString());
            Assert.Equal(HttpStatusCode.Forbidden, (await support.PatchJsonAsync($"/api/cabinets/{cabinet.Id}/name", body)).StatusCode);
        }
        var detail = await (await supervisor.GetAsync($"/api/cabinets/{cabinet.Id}")).ReadAsync<JsonElement>();
        Assert.Equal("North pharmacy", detail.GetProperty("cabinet").GetProperty("friendlyName").GetString());
        Assert.Equal(cabinet.MachineId, detail.GetProperty("cabinet").GetProperty("machineId").GetString());
        Assert.Equal(cabinet.Id, detail.GetProperty("cabinet").GetProperty("id").GetGuid());
        Assert.Equal(HttpStatusCode.BadRequest, (await supervisor.PatchJsonAsync($"/api/cabinets/{cabinet.Id}/name", new { FriendlyName = " ", Reason = "test" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await supervisor.PatchJsonAsync($"/api/cabinets/{cabinet.Id}/name", new { FriendlyName = new string('x', 121), Reason = "test" })).StatusCode);
        Assert.True(await _factory.WithDbAsync(db => db.AuditEntries.AnyAsync(a => a.CabinetId == cabinet.Id && a.Reason == "Correct label")));
    }

    [Fact]
    public async Task Supervisor_names_an_enrolled_cabinet_without_changing_device_identity()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        string machine = Guid.NewGuid().ToString();
        var agent = TestClient.CreateAgentClient(_factory, machine);
        (await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        { MachineId = machine, Hostname = "DUPLICATE-HOST", OsVersion = "Windows 10", AgentVersion = "test" })).EnsureSuccessStatusCode();
        var pending = await _factory.WithDbAsync(db => db.PendingRegistrations.AsNoTracking().SingleAsync(r => r.MachineId == machine));
        (await supervisor.PostJsonAsync($"/api/registrations/{pending.Id}/approve", new
        { ClientName = "Naming client", SiteName = "Naming site", Role = "Standalone", FriendlyName = "  Pharmacy cabinet  " })).EnsureSuccessStatusCode();
        var cabinet = await _factory.WithDbAsync(db => db.Cabinets.AsNoTracking().SingleAsync(c => c.MachineId == machine));
        var detail = await (await supervisor.GetAsync($"/api/cabinets/{cabinet.Id}")).ReadAsync<JsonElement>();
        Assert.True(detail.GetProperty("cabinet").TryGetProperty("friendlyName", out var name), "Cabinet readback must include its supervisor-chosen friendly name.");
        Assert.Equal("Pharmacy cabinet", name.GetString());
        Assert.Equal(machine, detail.GetProperty("cabinet").GetProperty("machineId").GetString());
        Assert.Equal("DUPLICATE-HOST", detail.GetProperty("cabinet").GetProperty("hostname").GetString());
    }
}
