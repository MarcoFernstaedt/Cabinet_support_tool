using System.Net;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Enums;
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

    [Fact]
    public async Task Requester_cannot_approve_their_own_action()
    {
        (HttpClient requesterClient, User requester) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Supervisor, Unique("selfapprover"));

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
            .Where(a => a.Action == AuditActions.ApproveAction &&
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
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier2, Unique("requester"));

        (HttpClient approverClient, User approver) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier2, Unique("approver"));

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
            .Where(a => a.Action == AuditActions.ApproveAction &&
                        a.Result == AuditResult.Success &&
                        a.ApprovedByUserId == approver.Id)
            .FirstAsync());

        Assert.Equal(AuditEventKind.Caused, approval.EventKind);
        Assert.Equal(cabinet.Id, approval.CabinetId);

        Assert.NotNull(stored.ExpiresUtc);
        Assert.True(stored.ExpiresUtc > DateTime.UtcNow);
    }

    [Fact]
    public async Task Pending_approval_list_excludes_the_callers_own_requests()
    {
        (HttpClient requesterClient, User requester) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier2, Unique("ownlist"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), requester.Id);

        Guid actionId = await RequestStopServiceAsync(requesterClient, cabinet.Id);

        var page = await (await requesterClient.GetAsync("/api/actions/pending-approval?pageSize=200"))
            .ReadAsync<Contracts.Common.PagedResult<ActionRequestDto>>();

        Assert.NotNull(page);
        Assert.DoesNotContain(page!.Items, i => i.Id == actionId);
    }

    [Fact]
    public async Task An_action_that_needs_no_approval_is_approved_on_creation_but_still_expires()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier1, Unique("tier1"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), user.Id);

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = CabinetActionType.ScanForUpdates,
            CabinetId = cabinet.Id,
            Reason = "Routine patch review."
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestDto? dto = await response.ReadAsync<ActionRequestDto>();
        Assert.NotNull(dto);
        Assert.Equal(ActionRequestStatus.Approved, dto!.Status);

        // No human approved it, so nobody is recorded as having done so.
        Assert.Null(dto.ApprovedByUserId);
        Assert.NotNull(dto.ExpiresUtc);
    }

    [Fact]
    public async Task Tier1_cannot_request_a_Tier2_action()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier1, Unique("lowtier"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("machine"), user.Id);

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = CabinetActionType.StopService,
            CabinetId = cabinet.Id,
            Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
            Reason = "Trying to reach above my role."
        });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.True(await TestClient.CountAuditAsync(
            _factory, AuditActions.RequestAction, AuditResult.Denied) > 0);
    }

    private static async Task<Guid> RequestStopServiceAsync(HttpClient client, Guid cabinetId)
    {
        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = CabinetActionType.StopService,
            CabinetId = cabinetId,
            Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
            Reason = "Print queue is wedged.",
            TicketReference = "SUP-1234"
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestDto? dto = await response.ReadAsync<ActionRequestDto>();
        Assert.NotNull(dto);
        Assert.Equal(ActionRequestStatus.PendingApproval, dto!.Status);

        return dto.Id;
    }

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
