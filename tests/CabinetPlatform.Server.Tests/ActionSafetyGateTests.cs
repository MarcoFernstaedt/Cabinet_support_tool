using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Domain;
using Microsoft.AspNetCore.Mvc;
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
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("t2"));

        Cabinet cabinet = await CabinetWithCheckInAsync(user.Id, anyUserLoggedOn: true);

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/actions", RebootRequest(cabinet.Id));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);

        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.RequestAction &&
                        a.Result == AuditResult.Denied &&
                        a.CabinetId == cabinet.Id)
            .ToListAsync());

        Assert.NotEmpty(denials);
    }

    [Fact]
    public async Task Reboot_is_blocked_when_the_logged_on_state_is_unknown()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("t2"));

        // No check-in at all, so the server has no idea whether a clinician is
        // standing at the cabinet. Unknown is treated as occupied.
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("silent"), user.Id);

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/actions", RebootRequest(cabinet.Id));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task Reboot_is_blocked_when_the_last_check_in_could_not_read_the_logged_on_state()
    {
        // Ruling 4. The cabinet checked in; the collector that answers "is
        // anyone standing at this machine?" failed, so the column is null.
        //
        // A null here used to be written as false — "nobody is logged on" —
        // which is the most dangerous possible reading of a failed collector:
        // it is indistinguishable from a genuinely idle cabinet and it lets a
        // reboot proceed on a controlled-substance cabinet mid-dispense.
        // Null means not collected, and not collected is unsafe.
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("t2"));

        Cabinet unknown = await CabinetWithCheckInAsync(user.Id, anyUserLoggedOn: null);
        Cabinet occupied = await CabinetWithCheckInAsync(user.Id, anyUserLoggedOn: true);

        HttpResponseMessage unknownResponse = await client.PostJsonAsync(
            "/api/actions", RebootRequest(unknown.Id));

        HttpResponseMessage occupiedResponse = await client.PostJsonAsync(
            "/api/actions", RebootRequest(occupied.Id));

        // Identical handling, asserted against the logged-on case rather than
        // against a hard-coded status, so the two cannot drift apart later.
        Assert.Equal(HttpStatusCode.Conflict, unknownResponse.StatusCode);
        Assert.Equal(occupiedResponse.StatusCode, unknownResponse.StatusCode);

        // Same refusal, word for word: the two cases are one code path, not two
        // that happen to agree today.
        Assert.Equal(await Detail(occupiedResponse), await Detail(unknownResponse));

        // Nothing was queued for either cabinet.
        int queued = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking()
            .CountAsync(a => a.CabinetId == unknown.Id || a.CabinetId == occupied.Id));

        Assert.Equal(0, queued);

        // And the refusal is on the record for both, as a denial always is.
        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.RequestAction &&
                        a.Result == AuditResult.Denied &&
                        (a.CabinetId == unknown.Id || a.CabinetId == occupied.Id))
            .ToListAsync());

        Assert.Contains(denials, d => d.CabinetId == unknown.Id);
        Assert.Contains(denials, d => d.CabinetId == occupied.Id);
    }

    [Fact]
    public async Task A_Tier2_cannot_override_the_safety_checks()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("t2"));

        Cabinet cabinet = await CabinetWithCheckInAsync(user.Id, anyUserLoggedOn: true);

        CreateActionRequest request = RebootRequest(cabinet.Id) with
        {
            OverrideSafetyChecks = true,
            OverrideReason = "The clinic says it is fine."
        };

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task A_Supervisor_override_requires_a_reason()
    {
        (HttpClient client, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        Cabinet cabinet = await CabinetWithCheckInAsync(supervisor.Id, anyUserLoggedOn: true);

        CreateActionRequest request = RebootRequest(cabinet.Id) with
        {
            OverrideSafetyChecks = true,
            OverrideReason = null
        };

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task A_Supervisor_override_with_a_reason_is_permitted_and_the_reason_is_recorded()
    {
        (HttpClient client, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        Cabinet cabinet = await CabinetWithCheckInAsync(supervisor.Id, anyUserLoggedOn: true);

        const string reason = "Cabinet unresponsive; site manager confirmed the floor is clear.";

        CreateActionRequest request = RebootRequest(cabinet.Id) with
        {
            OverrideSafetyChecks = true,
            OverrideReason = reason
        };

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestView? dto = await response.ReadAsync<ActionRequestView>();

        Assert.NotNull(dto);
        Assert.True(dto!.SafetyChecksOverridden);
        Assert.Equal(reason, dto.OverrideReason);

        // Still needs a second pair of eyes: an override skips the safety
        // interlock, not the approval.
        Assert.Equal(ActionRequestStatus.PendingApproval, dto.Status);

        Domain.AuditEntry record = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.RequestAction &&
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
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("t2"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("retired"), user.Id, isActive: false);

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/actions",
            new CreateActionRequest
            {
                Action = ActionName.FlushDnsCache,
                CabinetId = cabinet.Id,
                Reason = "Name resolution failing."
            });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    /// <summary>The human-readable reason out of a problem response.</summary>
    private static async Task<string?> Detail(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<ProblemDetails>(TestClient.Json))?.Detail;

    private async Task<Cabinet> CabinetWithCheckInAsync(Guid approvedBy, bool? anyUserLoggedOn)
    {
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("gated"), approvedBy);

        await _factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat
            {
                CabinetId = cabinet.Id,
                ReceivedUtc = DateTimeOffset.UtcNow,
                CollectedAtUtc = DateTimeOffset.UtcNow,
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
        Action = ActionName.RebootMachine,
        CabinetId = cabinetId,
        Parameters = new Dictionary<string, string> { ["delaySeconds"] = "30" },
        Reason = "Cabinet is unresponsive to the console."
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
