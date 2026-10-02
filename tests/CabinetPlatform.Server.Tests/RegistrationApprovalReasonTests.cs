using System.Net;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Registrations;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class RegistrationApprovalReasonTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public RegistrationApprovalReasonTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Supervisor_approval_persists_trimmed_named_reason_in_audit()
    {
        var (supervisor, user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, "approval-" + Guid.NewGuid().ToString("N")[..16]);
        (Guid id, string machine) = await RegisterAsync();

        using var response = await supervisor.PostJsonAsync($"/api/registrations/{id}/approve", new
        {
            ClientName = "Approval client", SiteName = machine, Role = CabinetRole.Standalone,
            ApprovalReason = "  Assigned to the verified site  ", TicketReference = "TICKET-42"
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var result = await _factory.WithDbAsync(db =>
            (from cabinet in db.Cabinets.AsNoTracking()
             join audit in db.AuditEntries.AsNoTracking() on cabinet.Id equals audit.CabinetId
             where cabinet.MachineId == machine && audit.Event == AuditEvent.ApproveRegistration
             select new { cabinet.ApprovedByUserId, audit.Reason, audit.TicketReference, audit.ActorId })
            .SingleAsync());
        Assert.Equal(user.Id, result.ApprovedByUserId);
        Assert.Equal(user.Id.ToString(), result.ActorId);
        Assert.Equal("Assigned to the verified site", result.Reason);
        Assert.Equal("TICKET-42", result.TicketReference);
    }

    [Fact]
    public async Task Supplied_blank_reason_is_refused_without_approving()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, "approval-" + Guid.NewGuid().ToString("N")[..16]);
        (Guid id, string machine) = await RegisterAsync();

        using var response = await supervisor.PostJsonAsync($"/api/registrations/{id}/approve", new
        {
            ClientName = "Approval client", SiteName = machine, Role = CabinetRole.Standalone,
            ApprovalReason = " \t\n "
        });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(RegistrationStatus.Pending, await _factory.WithDbAsync(db => db.PendingRegistrations
            .AsNoTracking().Where(r => r.Id == id).Select(r => r.Status).SingleAsync()));
        Assert.False(await _factory.WithDbAsync(db => db.Cabinets.AnyAsync(c => c.MachineId == machine)));
        Assert.False(await _factory.WithDbAsync(db => db.AuditEntries.AnyAsync(a =>
            a.Event == AuditEvent.ApproveRegistration && a.Result == AuditResult.Success && a.Reason == "")));
    }

    [Fact]
    public async Task Legacy_approval_without_reason_still_succeeds()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, "approval-" + Guid.NewGuid().ToString("N")[..16]);
        (Guid id, string machine) = await RegisterAsync();

        using var response = await supervisor.PostJsonAsync($"/api/registrations/{id}/approve", new
        { ClientName = "Approval client", SiteName = machine, Role = CabinetRole.Standalone });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(RegistrationStatus.Approved, await _factory.WithDbAsync(db => db.PendingRegistrations
            .AsNoTracking().Where(r => r.Id == id).Select(r => r.Status).SingleAsync()));
        var reason = await _factory.WithDbAsync(db =>
            (from cabinet in db.Cabinets.AsNoTracking()
             join audit in db.AuditEntries.AsNoTracking() on cabinet.Id equals audit.CabinetId
             where cabinet.MachineId == machine && audit.Event == AuditEvent.ApproveRegistration
             select audit.Reason).SingleAsync());
        Assert.Null(reason);
    }

    [Fact]
    public async Task Oversized_approval_reason_is_refused_without_approving()
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, "approval-" + Guid.NewGuid().ToString("N")[..16]);
        (Guid id, string machine) = await RegisterAsync();

        using var response = await supervisor.PostJsonAsync($"/api/registrations/{id}/approve", new
        {
            ClientName = "Approval client", SiteName = machine, Role = CabinetRole.Standalone,
            ApprovalReason = new string('A', 2001)
        });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(RegistrationStatus.Pending, await _factory.WithDbAsync(db => db.PendingRegistrations
            .AsNoTracking().Where(r => r.Id == id).Select(r => r.Status).SingleAsync()));
        Assert.False(await _factory.WithDbAsync(db => db.Cabinets.AnyAsync(c => c.MachineId == machine)));
    }

    private async Task<(Guid Id, string Machine)> RegisterAsync()
    {
        string machine = "approval-" + Guid.NewGuid().ToString("N")[..16];
        using var agent = TestClient.CreateAgentClient(_factory, machine);
        using var response = await agent.PostJsonAsync("/api/agent/register", new RegistrationRequest
        { MachineId = machine, Hostname = "approval-test", AgentVersion = "test", OsVersion = "Synthetic Windows" });
        Assert.True(response.IsSuccessStatusCode);
        Guid id = await _factory.WithDbAsync(db => db.PendingRegistrations.AsNoTracking()
            .Where(r => r.MachineId == machine).Select(r => r.Id).SingleAsync());
        return (id, machine);
    }
}
