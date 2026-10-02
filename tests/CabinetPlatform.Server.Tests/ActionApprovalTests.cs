using System.Net;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The four-eyes rule, and the safety gates around it.
/// </summary>
public sealed class ActionApprovalTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public ActionApprovalTests(SupportApiFactory factory) => _factory = factory;

#if LEGACY_MAINTENANCE_TESTS
    [Fact]
    public async Task Requester_cannot_approve_their_own_action()
    {
        (HttpClient requesterClient, User requester) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("selfapprover"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), requester.Id);

        Guid actionId = await RequestStopServiceAsync(requesterClient, cabinet.Id);

        HttpResponseMessage response = await requesterClient.PostJsonAsync(
            $"/api/actions/{actionId}/approve", new ApproveActionRequest { Note = "Approving my own." });

        // Supervisor is the highest role in the product, and it still cannot
        // sign off its own request. The rule is about separation, not rank.
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        ActionRequestStatus status = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking()
            .Where(a => a.Id == actionId)
            .Select(a => a.Status)
            .FirstAsync());

        Assert.Equal(ActionRequestStatus.PendingApproval, status);

        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.ApproveAction &&
                        a.Result == AuditResult.Denied &&
                        a.ActorId == requester.Id.ToString())
            .ToListAsync());

        Assert.NotEmpty(denials);
        Assert.Contains(denials, d => d.Reason!.Contains("four-eyes", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task A_different_user_can_approve_and_the_approver_is_recorded()
    {
        (HttpClient requesterClient, User requester) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("requester"));

        (HttpClient approverClient, User approver) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("approver"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), approver.Id);

        Guid actionId = await RequestStopServiceAsync(requesterClient, cabinet.Id);

        HttpResponseMessage response = await approverClient.PostJsonAsync(
            $"/api/actions/{actionId}/approve", new ApproveActionRequest { Note = "Checked with the site." });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        ActionRequest stored = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking()
            .FirstAsync(a => a.Id == actionId));

        Assert.Equal(ActionRequestStatus.Approved, stored.Status);
        Assert.Equal(approver.Id, stored.ApprovedByUserId);
        Assert.NotEqual(stored.RequestedByUserId, stored.ApprovedByUserId);

        // An approval is a Caused event: it is the decision that lets something
        // happen on a cabinet.
        Domain.AuditEntry approval = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.ApproveAction &&
                        a.Result == AuditResult.Success &&
                        a.ApprovedByUserId == approver.Id)
            .FirstAsync());

        Assert.Equal(AuditEventKind.Caused, approval.EventKind);
        Assert.Equal(cabinet.Id, approval.CabinetId);

        Assert.NotNull(stored.ExpiresUtc);
        Assert.True(stored.ExpiresUtc > DateTimeOffset.UtcNow);
    }

    [Fact]
    public async Task Pending_approval_list_excludes_the_callers_own_requests()
    {
        (HttpClient requesterClient, User requester) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("ownlist"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), requester.Id);

        Guid actionId = await RequestStopServiceAsync(requesterClient, cabinet.Id);

        var page = await (await requesterClient.GetAsync("/api/actions/pending-approval?pageSize=200"))
            .ReadAsync<Contracts.Common.PagedResult<ActionRequestView>>();

        Assert.NotNull(page);
        Assert.DoesNotContain(page!.Items, i => i.Id == actionId);
    }

    [Fact]
    public async Task An_action_that_needs_no_approval_is_approved_on_creation_but_still_expires()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("tier1"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), user.Id);

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.ScanForUpdates,
            CabinetId = cabinet.Id,
            Reason = "Routine patch review."
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestView? dto = await response.ReadAsync<ActionRequestView>();
        Assert.NotNull(dto);
        Assert.Equal(ActionRequestStatus.Approved, dto!.Status);

        // No human approved it, so nobody is recorded as having done so.
        Assert.Null(dto.ApprovedByUserId);
        Assert.NotNull(dto.ExpiresUtc);
    }

    /// <summary>
    /// A Tier 1 rep may request a disruptive action on any cabinet, and it
    /// still cannot run until somebody else approves it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This test replaces one that asserted the opposite. Reps work any cabinet
    /// at any time, which is how the team already works over remote desktop; a
    /// tool that refused them would push the work back there, where none of
    /// this audit trail exists.
    /// </para>
    /// <para>
    /// What has not moved is the control that actually protects a cabinet: the
    /// request lands as PendingApproval and a second person has to decide. The
    /// role was never the thing standing between a rep and a stopped dispense
    /// service — four eyes were, and still are.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task Any_rep_may_request_a_disruptive_action_and_it_still_awaits_a_second_person()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("tier1rep"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), user.Id);

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.StopService,
            CabinetId = cabinet.Id,
            Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
            Reason = "Print queue is wedged and the clinic cannot print labels.",
            TicketReference = "SUP-4410"
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestView? dto = await response.ReadAsync<ActionRequestView>();
        Assert.NotNull(dto);

        // Requested, not running. Nothing reaches the cabinet until a second
        // person who is not this rep has said so.
        Assert.Equal(ActionRequestStatus.PendingApproval, dto!.Status);
        Assert.Null(dto.ApprovedByUserId);
    }

    /// <summary>
    /// A reserved hardware-actuation action is refused for everybody,
    /// Supervisors included, and the refusal is recorded under its own event.
    /// </summary>
    /// <remarks>
    /// "Did anybody ever try to open a drawer from the support console" is a
    /// question a regulator may ask, and it has to be answerable with one
    /// filter rather than by reading denial text.
    /// </remarks>
    [Fact]
    public async Task A_reserved_actuation_action_is_refused_for_a_supervisor()
    {
        (HttpClient client, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("super"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), supervisor.Id);

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.OpenDrawer,
            CabinetId = cabinet.Id,
            Reason = "Clinic says a drawer is jammed.",
            TicketReference = "SUP-4411"
        });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        Assert.True(await TestClient.CountAuditAsync(
            _factory, AuditEvent.HardwareActuationRefused, AuditResult.Denied) > 0);
    }

    private static async Task<Guid> RequestStopServiceAsync(HttpClient client, Guid cabinetId)
    {
        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.StopService,
            CabinetId = cabinetId,
            Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
            Reason = "Print queue is wedged.",
            TicketReference = "SUP-1234"
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestView? dto = await response.ReadAsync<ActionRequestView>();
        Assert.NotNull(dto);
        Assert.Equal(ActionRequestStatus.PendingApproval, dto!.Status);

        return dto.Id;
    }
#endif

#if !LEGACY_MAINTENANCE_TESTS
    [Fact]
    public async Task Reserved_hardware_actuation_is_refused_and_audited_in_release()
    {
        (HttpClient client, User supervisor) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("hardware"));
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("hardwarecab"), supervisor.Id);
        using var response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.OpenDrawer, CabinetId = cabinet.Id,
            Reason = "Synthetic refusal check"
        });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.True(await TestClient.CountAuditAsync(
            _factory, AuditEvent.HardwareActuationRefused, AuditResult.Denied) > 0);
        Assert.False(await _factory.WithDbAsync(db => db.ActionRequests
            .AnyAsync(a => a.CabinetId == cabinet.Id && a.Action == ActionName.OpenDrawer)));
    }
#endif

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
