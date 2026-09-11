using System.Net;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The gates around a disruptive action on a controlled-substance cabinet.
/// </summary>
public sealed class ActionSafetyGateTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public ActionSafetyGateTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Reboot_is_blocked_while_a_user_is_logged_on()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier2, Unique("t2"));

        Cabinet cabinet = await CabinetWithCheckInAsync(user.Id, anyUserLoggedOn: true);

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/actions", RebootRequest(cabinet.Id));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);

        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == AuditActions.RequestAction &&
                        a.Result == AuditResult.Denied &&
                        a.CabinetId == cabinet.Id)
            .ToListAsync());

        Assert.NotEmpty(denials);
    }

    [Fact]
    public async Task Reboot_is_blocked_when_the_logged_on_state_is_unknown()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier2, Unique("t2"));

        // No check-in at all, so the server has no idea whether a clinician is
        // standing at the cabinet. Unknown is treated as occupied.
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("silent"), user.Id);

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/actions", RebootRequest(cabinet.Id));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task A_Tier2_cannot_override_the_safety_checks()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier2, Unique("t2"));

        Cabinet cabinet = await CabinetWithCheckInAsync(user.Id, anyUserLoggedOn: true);

        CreateActionRequest request = RebootRequest(cabinet.Id);
        request.OverrideSafetyChecks = true;
        request.OverrideReason = "The clinic says it is fine.";

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task A_Supervisor_override_requires_a_reason()
    {
        (HttpClient client, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Supervisor, Unique("sup"));

        Cabinet cabinet = await CabinetWithCheckInAsync(supervisor.Id, anyUserLoggedOn: true);

        CreateActionRequest request = RebootRequest(cabinet.Id);
        request.OverrideSafetyChecks = true;
        request.OverrideReason = null;

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task A_Supervisor_override_with_a_reason_is_permitted_and_the_reason_is_recorded()
    {
        (HttpClient client, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Supervisor, Unique("sup"));

        Cabinet cabinet = await CabinetWithCheckInAsync(supervisor.Id, anyUserLoggedOn: true);

        const string reason = "Cabinet unresponsive; site manager confirmed the floor is clear.";

        CreateActionRequest request = RebootRequest(cabinet.Id);
        request.OverrideSafetyChecks = true;
        request.OverrideReason = reason;

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestDto? dto = await response.ReadAsync<ActionRequestDto>();

        Assert.NotNull(dto);
        Assert.True(dto!.SafetyChecksOverridden);
        Assert.Equal(reason, dto.OverrideReason);

        // Still needs a second pair of eyes: an override skips the safety
        // interlock, not the approval.
        Assert.Equal(ActionRequestStatus.PendingApproval, dto.Status);

        Domain.AuditEntry record = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == AuditActions.RequestAction &&
                        a.Result == AuditResult.Success &&
                        a.CabinetId == cabinet.Id)
            .OrderByDescending(a => a.TimestampUtc)
            .FirstAsync());

        Assert.Equal(AuditEventKind.Caused, record.EventKind);
        Assert.Contains(reason, record.Details!);
    }

    [Fact]
    public async Task An_action_against_a_deactivated_cabinet_is_refused()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier2, Unique("t2"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("retired"), user.Id, isActive: false);

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/actions",
            new CreateActionRequest
            {
                Action = CabinetActionType.FlushDnsCache,
                CabinetId = cabinet.Id,
                Reason = "Name resolution failing."
            });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    private async Task<Cabinet> CabinetWithCheckInAsync(Guid approvedBy, bool anyUserLoggedOn)
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("gated"), approvedBy);

        await _factory.WithDbAsync(async db =>
        {
            db.CheckIns.Add(new CheckIn
            {
                CabinetId = cabinet.Id,
                ReceivedUtc = DateTime.UtcNow,
                CollectedAtUtc = DateTime.UtcNow,
                PayloadJson = "{}",
                AnyUserLoggedOn = anyUserLoggedOn,
                WorstDiskHealth = DiskHealthStatus.Healthy,
                MinFreeDiskPercent = 55
            });

            await db.SaveChangesAsync();
        });

        return cabinet;
    }

    private static CreateActionRequest RebootRequest(Guid cabinetId) => new()
    {
        Action = CabinetActionType.RebootMachine,
        CabinetId = cabinetId,
        Parameters = new Dictionary<string, string> { ["delaySeconds"] = "30" },
        Reason = "Cabinet is unresponsive to the console."
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
