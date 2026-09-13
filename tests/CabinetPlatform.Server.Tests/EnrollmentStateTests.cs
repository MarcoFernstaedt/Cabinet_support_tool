using System.Net;
using System.Security.Claims;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Registrations;
using CabinetPlatform.Server.Controllers;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using CabinetPlatform.Contracts.Auth;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class EnrollmentStateTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public EnrollmentStateTests(SupportApiFactory factory) => _factory = factory;

    [Theory]
    [InlineData(" ", "Site", CabinetRole.Standalone)]
    [InlineData("Client", " ", CabinetRole.Standalone)]
    [InlineData("Client", "Site", (CabinetRole)999)]
    public async Task Invalid_approval_cannot_activate_a_registration(string client, string site, CabinetRole role)
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, "invalid-" + Guid.NewGuid().ToString("N")[..16]);
        string machine = "invalid-" + Guid.NewGuid().ToString("N")[..16];
        using var agent = TestClient.CreateAgentClient(_factory, machine);
        await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        { MachineId = machine, Hostname = "invalid", AgentVersion = "test", OsVersion = "Synthetic Windows" });
        Guid id = await _factory.WithDbAsync(db => db.PendingRegistrations.Where(r => r.MachineId == machine).Select(r => r.Id).SingleAsync());
        var response = await supervisor.PostJsonAsync($"/api/registrations/{id}/approve", new ApproveRegistrationRequest
        { ClientName = client, SiteName = site, Role = role });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.False(await _factory.WithDbAsync(db => db.Cabinets.AnyAsync(c => c.MachineId == machine)));
    }

    [Fact]
    public async Task Blank_rejection_reason_cannot_record_a_supervisor_decision()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, "reason-" + Guid.NewGuid().ToString("N")[..16]);
        string machine = "reason-" + Guid.NewGuid().ToString("N")[..16];
        using var agent = TestClient.CreateAgentClient(_factory, machine);
        await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        { MachineId = machine, Hostname = "invalid", AgentVersion = "test", OsVersion = "Synthetic Windows" });
        Guid id = await _factory.WithDbAsync(db => db.PendingRegistrations.Where(r => r.MachineId == machine).Select(r => r.Id).SingleAsync());
        var response = await supervisor.PostJsonAsync($"/api/registrations/{id}/reject", new RejectRegistrationRequest { Reason = "   " });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(RegistrationStatus.Pending, await _factory.WithDbAsync(db => db.PendingRegistrations.Where(r => r.Id == id).Select(r => r.Status).SingleAsync()));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_stale_opposite_decision_cannot_overwrite_the_winning_supervisor(bool winnerApproves)
    {
        var (supervisor, user) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, "race-" + Guid.NewGuid().ToString("N")[..16]);
        string machine = "race-" + Guid.NewGuid().ToString("N")[..16];
        using var agent = TestClient.CreateAgentClient(_factory, machine);
        await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        { MachineId = machine, Hostname = "same", AgentVersion = "test", OsVersion = "Synthetic Windows" });
        using var staleScope = _factory.Services.CreateScope();
        var db = staleScope.ServiceProvider.GetRequiredService<SupportDbContext>();
        // Freeze the losing request's tracked read before a competing HTTP
        // decision commits. This makes the read/write interleaving deterministic.
        var stale = await db.PendingRegistrations.SingleAsync(r => r.MachineId == machine);
        var approval = new ApproveRegistrationRequest { ClientName = "Race client", SiteName = machine, Role = CabinetRole.Standalone };
        var rejection = new RejectRegistrationRequest { Reason = "Not our machine" };
        var winner = winnerApproves
            ? await supervisor.PostJsonAsync($"/api/registrations/{stale.Id}/approve", approval)
            : await supervisor.PostJsonAsync($"/api/registrations/{stale.Id}/reject", rejection);
        Assert.True(winner.IsSuccessStatusCode);
        var controller = ActivatorUtilities.CreateInstance<RegistrationsController>(staleScope.ServiceProvider);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext
        {
            RequestServices = staleScope.ServiceProvider,
            User = new ClaimsPrincipal(new ClaimsIdentity(new[]
            {
                new Claim(SupportClaims.UserId, user.Id.ToString()),
                new Claim(SupportClaims.Role, Role.Supervisor.ToString()),
                new Claim(ClaimTypes.Name, user.Username)
            }, "test"))
        }};
        ActionResult loser = winnerApproves
            ? await controller.Reject(stale.Id, rejection, CancellationToken.None)
            : (await controller.Approve(stale.Id, approval, CancellationToken.None)).Result!;
        Assert.Equal(409, Assert.IsType<ObjectResult>(loser).StatusCode);
        Assert.Equal(winnerApproves ? RegistrationStatus.Approved : RegistrationStatus.Rejected,
            await _factory.WithDbAsync(fresh => fresh.PendingRegistrations.Where(r => r.Id == stale.Id).Select(r => r.Status).SingleAsync()));
        Assert.Equal(winnerApproves ? 1 : 0,
            await _factory.WithDbAsync(fresh => fresh.Cabinets.CountAsync(c => c.MachineId == machine)));
    }

    [Fact]
    public async Task Re_registration_of_an_inactive_cabinet_does_not_claim_approval()
    {
        var (_, supervisor) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, "sup-" + Guid.NewGuid().ToString("N")[..16]);
        string machine = "inactive-" + Guid.NewGuid().ToString("N")[..16];
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, machine, supervisor.Id, isActive: false);
        using var agent = TestClient.CreateAgentClient(_factory, machine);
        for (int i = 0; i < 2; i++)
        {
            var response = await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
            { MachineId = machine, Hostname = "inactive", AgentVersion = "test", OsVersion = "Synthetic Windows" });
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.ReadAsync<RegistrationResponse>();
            Assert.Equal(RegistrationStatus.Rejected, body!.Status);
            Assert.Null(body.CabinetId);
        }
        Assert.False(await _factory.WithDbAsync(db => db.Cabinets.Where(c => c.Id == cabinet.Id).Select(c => c.IsActive).SingleAsync()));
        Assert.False(await _factory.WithDbAsync(db => db.PendingRegistrations.AnyAsync(r => r.MachineId == machine)));
    }
}
