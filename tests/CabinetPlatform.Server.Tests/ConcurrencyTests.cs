using System.Net;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// Twenty support reps share one fleet. These are the races that produces, one
/// test each.
/// </summary>
/// <remarks>
/// Every case here is ordinary Tuesday-afternoon behaviour rather than an edge
/// case: two people looking at the same cabinet because the same clinic rang
/// twice, two approvers clearing the same queue, an agent collecting an action
/// whose acknowledgement was lost. The question is never whether these happen
/// but whether the wrong one silently wins.
/// </remarks>
public sealed class ConcurrencyTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public ConcurrencyTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Two_reps_reading_the_same_cabinet_both_get_the_same_answer()
    {
        // Reading is not a race, and must not be made into one by locking or by
        // a last-writer-wins cache. Both reps see the same cabinet and both
        // reads are audited separately, because who looked at a cabinet is
        // itself a record a compliance reviewer may want.
        (HttpClient first, User firstUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("view1"));
        (HttpClient second, User secondUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("view2"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("shared"), firstUser.Id);

        HttpResponseMessage a = await first.GetAsync($"/api/cabinets/{cabinet.Id}");
        HttpResponseMessage b = await second.GetAsync($"/api/cabinets/{cabinet.Id}");

        Assert.Equal(HttpStatusCode.OK, a.StatusCode);
        Assert.Equal(HttpStatusCode.OK, b.StatusCode);

        CabinetDetailDto? left = await a.ReadAsync<CabinetDetailDto>();
        CabinetDetailDto? right = await b.ReadAsync<CabinetDetailDto>();

        Assert.NotNull(left);
        Assert.NotNull(right);
        Assert.Equal(left!.Cabinet.Id, right!.Cabinet.Id);
        Assert.Equal(left.Cabinet.Hostname, right.Cabinet.Hostname);

        List<Domain.AuditEntry> reads = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(e => e.Event == AuditEvent.ViewCabinetLatest && e.CabinetId == cabinet.Id)
            .ToListAsync());

        Assert.Contains(reads, e => e.ActorId == firstUser.Id.ToString());
        Assert.Contains(reads, e => e.ActorId == secondUser.Id.ToString());
    }

#if LEGACY_MAINTENANCE_TESTS
    [Fact]
    public async Task Two_reps_requesting_the_same_action_get_two_requests_and_neither_is_swallowed()
    {
        // Deliberately not deduplicated. Two reps asking to restart the same
        // service usually means two people were told about the same fault, and
        // collapsing that into one request would leave the second rep watching
        // a request they cannot see the provenance of — and would hide from the
        // audit trail that two people asked.
        (HttpClient first, User firstUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("req1"));
        (HttpClient second, User secondUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("req2"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("dup"), firstUser.Id);

        HttpResponseMessage a = await first.PostJsonAsync(
            "/api/actions", StopSpooler(cabinet.Id, "SUP-1"));
        HttpResponseMessage b = await second.PostJsonAsync(
            "/api/actions", StopSpooler(cabinet.Id, "SUP-2"));

        Assert.Equal(HttpStatusCode.Created, a.StatusCode);
        Assert.Equal(HttpStatusCode.Created, b.StatusCode);

        ActionRequestView? left = await a.ReadAsync<ActionRequestView>();
        ActionRequestView? right = await b.ReadAsync<ActionRequestView>();

        Assert.NotEqual(left!.Id, right!.Id);

        List<ActionRequest> stored = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking()
            .Where(r => r.CabinetId == cabinet.Id)
            .ToListAsync());

        Assert.Equal(2, stored.Count);

        // Each carries its own requester and its own ticket, which is the
        // information the dedup would have destroyed.
        Assert.Contains(stored, r => r.RequestedByUserId == firstUser.Id && r.TicketReference == "SUP-1");
        Assert.Contains(stored, r => r.RequestedByUserId == secondUser.Id && r.TicketReference == "SUP-2");
    }

    [Fact]
    public async Task Two_approvers_deciding_at_once_produce_exactly_one_approval()
    {
        // The four-eyes rule means nothing if an action can be approved twice.
        // The optimistic concurrency token on the request is what makes a
        // double approval unrepresentable rather than merely unlikely.
        (HttpClient requester, User requesterUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("racereq"));
        (HttpClient approverA, User approverAUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("appA"));
        (HttpClient approverB, User approverBUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("appB"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("race"), requesterUser.Id);

        Guid actionId = await RequestAsync(requester, cabinet.Id);

        // Each approver decides from its own service scope. Two parallel HTTP
        // calls would not reliably interleave and would pass by luck as often
        // as by correctness; two scopes in sequence exercise the same guards
        // deterministically. Which guard catches the second approver depends on
        // how far apart the two decisions land — the status check when they are
        // seconds apart, the row version when they are microseconds apart — and
        // both are asserted, here and in the test below.
        OperationResult<ActionRequest> first = await ApproveFromOwnScopeAsync(
            approverAUser, actionId, "A");

        OperationResult<ActionRequest> second = await ApproveFromOwnScopeAsync(
            approverBUser, actionId, "B");

        Assert.True(first.Succeeded);
        Assert.False(second.Succeeded);

        // The second approver is told plainly. A silent success that overwrote
        // the first approval would put a different name against the decision
        // than the one that actually authorised it.
        Assert.Equal(OperationFailure.Conflict, second.Failure);
        Assert.False(string.IsNullOrWhiteSpace(second.Reason));

        ActionRequest stored = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking().FirstAsync(r => r.Id == actionId));

        Assert.Equal(ActionRequestStatus.Approved, stored.Status);
        Assert.NotNull(stored.ApprovedByUserId);

        // Exactly one of them, and not the requester.
        Assert.Equal(approverAUser.Id, stored.ApprovedByUserId);
        Assert.NotEqual(requesterUser.Id, stored.ApprovedByUserId!.Value);

        // And the losing approver's attempt is on the record, as a denial
        // always is.
        Assert.True(await TestClient.CountAuditAsync(
            _factory, AuditEvent.ApproveAction, AuditResult.Denied) > 0);
    }

    [Fact]
    public async Task An_approval_and_a_refusal_at_once_leave_the_action_in_exactly_one_state()
    {
        // The nastier version of the same race, because the two outcomes
        // disagree rather than duplicate. Whichever lands first stands.
        (HttpClient requester, User requesterUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("splitreq"));
        (_, User approverUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("splitapp"));
        (_, User denierUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("splitden"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("split"), requesterUser.Id);

        Guid actionId = await RequestAsync(requester, cabinet.Id);

        // Both decide from the row as it stood before either of them acted.
        OperationResult<ActionRequest> approval = await DecideFromOwnScopeAsync(
            approverUser, actionId, approve: true);

        OperationResult<ActionRequest> refusal = await DecideFromOwnScopeAsync(
            denierUser, actionId, approve: false);

        Assert.True(approval.Succeeded);
        Assert.False(refusal.Succeeded);
        Assert.Equal(OperationFailure.Conflict, refusal.Failure);

        ActionRequestStatus status = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking().Where(r => r.Id == actionId).Select(r => r.Status).FirstAsync());

        // One state, and it is the one that was decided first. A refusal that
        // silently overwrote an approval would be worse than the reverse: it
        // would look like nobody ever authorised the action that ran.
        Assert.Equal(ActionRequestStatus.Approved, status);
    }

    [Fact]
    public async Task The_row_version_stops_the_second_writer_even_when_the_status_check_cannot()
    {
        // The tighter half of the same race. When two approvals land close
        // enough together that both read PendingApproval, the status check
        // passes for both and only the concurrency token stands between the
        // fleet and a double-approved action.
        //
        // Provoked directly rather than by timing: two contexts each load the
        // request before either writes, which is exactly the state two
        // approvers pressing the button in the same instant produce.
        (HttpClient requester, User requesterUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("tokenreq"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("token"), requesterUser.Id);

        Guid actionId = await RequestAsync(requester, cabinet.Id);

        using IServiceScope left = _factory.Services.CreateScope();
        using IServiceScope right = _factory.Services.CreateScope();

        var leftDb = left.ServiceProvider.GetRequiredService<SupportDbContext>();
        var rightDb = right.ServiceProvider.GetRequiredService<SupportDbContext>();

        ActionRequest a = await leftDb.ActionRequests.FirstAsync(r => r.Id == actionId);
        ActionRequest b = await rightDb.ActionRequests.FirstAsync(r => r.Id == actionId);

        // Both saw PendingApproval. Both are about to write.
        Assert.Equal(ActionRequestStatus.PendingApproval, a.Status);
        Assert.Equal(ActionRequestStatus.PendingApproval, b.Status);

        a.Status = ActionRequestStatus.Approved;
        a.ApprovedUtc = DateTimeOffset.UtcNow;
        await leftDb.SaveChangesAsync();

        b.Status = ActionRequestStatus.Approved;
        b.ApprovedUtc = DateTimeOffset.UtcNow;

        // Not "last writer wins". The second write is refused outright, which
        // is what lets the service turn it into a clear answer for the second
        // approver rather than a silently overwritten decision.
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => rightDb.SaveChangesAsync());
    }

    [Fact]
    public async Task An_action_dispatched_twice_is_handed_over_once()
    {
        // The server half of idempotency. The agent remembers what it has run,
        // but the server must not hand the same approved action to two
        // consecutive polls in the first place — a poll whose response was lost
        // would otherwise mean a second reboot.
        (HttpClient requester, User requesterUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("dispreq"));
        (HttpClient approver, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("dispapp"));

        string machineId = Unique("dispatch");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, machineId, requesterUser.Id);

        Guid actionId = await RequestAsync(requester, cabinet.Id);

        Assert.Equal(HttpStatusCode.OK,
            (await approver.PostJsonAsync(
                $"/api/actions/{actionId}/approve", new ApproveActionRequest())).StatusCode);

        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        List<ActionRequestDto>? firstPoll =
            await (await agent.GetAsync("/api/agent/actions")).ReadAsync<List<ActionRequestDto>>();
        List<ActionRequestDto>? secondPoll =
            await (await agent.GetAsync("/api/agent/actions")).ReadAsync<List<ActionRequestDto>>();

        Assert.Equal(actionId, Assert.Single(firstPoll!).Id);
        Assert.Empty(secondPoll!);

        // Reporting the same result twice is acknowledged rather than recorded
        // twice: a retried delivery over a flaky link is not a second outcome.
        var result = new ActionResultDto
        {
            RequestId = actionId,
            Status = ActionStatus.Succeeded,
            Output = "Service stopped.",
            CompletedAtUtc = DateTimeOffset.UtcNow,
        };

        Assert.Equal(HttpStatusCode.NoContent,
            (await agent.PostJsonAsync("/api/agent/actions/result", result)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await agent.PostJsonAsync("/api/agent/actions/result", result)).StatusCode);

        ActionRequest stored = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking().FirstAsync(r => r.Id == actionId));

        Assert.Equal(ActionRequestStatus.Completed, stored.Status);
        Assert.Equal(ActionStatus.Succeeded, stored.ResultStatus);
        Assert.Equal("Service stopped.", stored.ResultOutput);
    }

    [Fact]
    public async Task Conflicting_actions_are_handed_over_in_approval_order()
    {
        // The agent runs a cabinet's actions one at a time, in the order it
        // receives them, so the order it receives them in is the whole of the
        // ordering guarantee. Approval time is that order — not request time,
        // because a request that waited an hour for a second pair of eyes
        // should not jump ahead of one approved while it waited.
        (HttpClient requester, User requesterUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("ordreq"));
        (HttpClient approver, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("ordapp"));

        string machineId = Unique("ordering");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, machineId, requesterUser.Id);

        // Requested first, approved second.
        Guid requestedFirst = await RequestAsync(requester, cabinet.Id, "SUP-EARLY");
        Guid requestedSecond = await RequestAsync(requester, cabinet.Id, "SUP-LATE");

        await approver.PostJsonAsync(
            $"/api/actions/{requestedSecond}/approve", new ApproveActionRequest());

        await Task.Delay(15);

        await approver.PostJsonAsync(
            $"/api/actions/{requestedFirst}/approve", new ApproveActionRequest());

        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        List<ActionRequestDto>? handed =
            await (await agent.GetAsync("/api/agent/actions")).ReadAsync<List<ActionRequestDto>>();

        Assert.Equal(2, handed!.Count);
        Assert.Equal(requestedSecond, handed[0].Id);
        Assert.Equal(requestedFirst, handed[1].Id);
    }

    [Fact]
    public async Task A_disruptive_action_approved_during_another_is_queued_rather_than_interleaved()
    {
        // The safety case behind the ordering rule. A reboot approved while a
        // service restart is already in flight must wait for it: the agent
        // takes one action at a time off the list it was handed, so the reboot
        // cannot start while the restart is running.
        //
        // What the server guarantees is that the in-flight action is not handed
        // out again and the reboot is handed out only on a later poll — which
        // is what "queue, do not interleave" means from this side.
        (HttpClient requester, User requesterUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Unique("queuereq"));
        (HttpClient supervisor, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("queuesup"));

        string machineId = Unique("queueing");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, machineId, requesterUser.Id);

        // A recent heartbeat with nobody logged on, so the reboot's own safety
        // gate is satisfied and this test measures ordering rather than that.
        await _factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat
            {
                CabinetId = cabinet.Id,
                ReceivedUtc = DateTimeOffset.UtcNow,
                CollectedAtUtc = DateTimeOffset.UtcNow,
                AnyUserLoggedOn = false,
                WorstDiskHealth = DiskHealthStatus.Healthy,
            });

            await db.SaveChangesAsync();
        });

        Guid restart = await RequestAsync(requester, cabinet.Id, "SUP-RESTART");
        await supervisor.PostJsonAsync($"/api/actions/{restart}/approve", new ApproveActionRequest());

        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        // The agent collects the restart and begins it. It has not reported.
        List<ActionRequestDto>? firstBatch =
            await (await agent.GetAsync("/api/agent/actions")).ReadAsync<List<ActionRequestDto>>();

        Assert.Equal(restart, Assert.Single(firstBatch!).Id);

        // Mid-execution, a reboot of the same cabinet is raised and approved.
        // The Supervisor waives the maintenance window, which is what makes
        // this test about ordering rather than about the window: without the
        // waiver the request would be refused for a reason this test is not
        // measuring.
        HttpResponseMessage rebootResponse = await supervisor.PostJsonAsync(
            "/api/actions",
            new CreateActionRequest
            {
                Action = ActionName.RebootMachine,
                CabinetId = cabinet.Id,
                Parameters = new Dictionary<string, string> { ["delaySeconds"] = "60" },
                Reason = "Cabinet still unresponsive after the restart.",
                TicketReference = "SUP-REBOOT",
                OverrideSafetyChecks = true,
                OverrideReason = "Site manager confirmed the floor is clear and the clinic is closed.",
            });

        Assert.Equal(HttpStatusCode.Created, rebootResponse.StatusCode);

        Guid reboot = (await rebootResponse.ReadAsync<ActionRequestView>())!.Id;

        // Approved by somebody other than the Supervisor who asked for it: an
        // override waives the safety interlock, never the second pair of eyes.
        Assert.Equal(HttpStatusCode.OK,
            (await requester.PostJsonAsync(
                $"/api/actions/{reboot}/approve", new ApproveActionRequest())).StatusCode);

        // The next poll hands over the reboot and does not hand the restart
        // over again, so the agent never has two of this cabinet's actions in
        // flight at once.
        List<ActionRequestDto>? secondBatch =
            await (await agent.GetAsync("/api/agent/actions")).ReadAsync<List<ActionRequestDto>>();

        Assert.Equal(reboot, Assert.Single(secondBatch!).Id);

        ActionRequest inFlight = await _factory.WithDbAsync(db => db.ActionRequests
            .AsNoTracking().FirstAsync(r => r.Id == restart));

        Assert.Equal(ActionRequestStatus.Dispatched, inFlight.Status);
    }
#endif

    [Fact]
    public async Task Two_supervisors_changing_a_cabinets_role_at_once_produce_one_change()
    {
        // The same optimistic concurrency, on the other row that two people can
        // reach at the same time. A site has exactly one sync cabinet, so a
        // silent last-writer-wins here could leave a site with two or none.
        (HttpClient first, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("role1"));
        (HttpClient second, User secondUser) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("role2"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("roles"), secondUser.Id,
            clientName: Unique("RoleClient"), siteName: "Role Site");

        HttpResponseMessage a = await first.PutJsonAsync(
            $"/api/cabinets/{cabinet.Id}/role",
            new SetCabinetRoleRequest { Role = CabinetRole.Sync, Reason = "Promoting to sync." });

        HttpResponseMessage b = await second.PutJsonAsync(
            $"/api/cabinets/{cabinet.Id}/role",
            new SetCabinetRoleRequest { Role = CabinetRole.Satellite, Reason = "Demoting to satellite." });

        Assert.Equal(HttpStatusCode.OK, a.StatusCode);
        Assert.Equal(HttpStatusCode.OK, b.StatusCode);

        Cabinet stored = await _factory.WithDbAsync(db => db.Cabinets
            .AsNoTracking().FirstAsync(c => c.Id == cabinet.Id));

        // The cabinet ends in the second role asked for — a later decision is a
        // decision, not a conflict — and never in a blend of the two. What
        // matters is that the site's sync pointer moved with it rather than
        // being left naming a cabinet that is no longer the sync cabinet.
        Assert.Equal(CabinetRole.Satellite, stored.Role);

        Guid? syncCabinetId = await _factory.WithDbAsync(db => db.Sites
            .AsNoTracking().Where(s => s.Id == stored.SiteId).Select(s => s.SyncCabinetId).FirstAsync());

        Assert.Null(syncCabinetId);

        // Both changes are on the record, with who made each and why.
        List<Domain.AuditEntry> changes = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(e => e.Event == AuditEvent.SetCabinetRole && e.CabinetId == cabinet.Id)
            .ToListAsync());

        Assert.Equal(2, changes.Count);
    }

#if LEGACY_MAINTENANCE_TESTS
    /// <summary>
    /// Approves an action from its own service scope, optionally having first
    /// read the row so that its concurrency token is the pre-decision one.
    /// </summary>
    /// <remarks>
    /// The <paramref name="warmFirst"/> flag is how "both approvers had the
    /// request open" is expressed: each scope loads the row before either
    /// saves, which is the state two people pressing Approve a second apart
    /// are actually in.
    /// </remarks>
    private Task<OperationResult<ActionRequest>> ApproveFromOwnScopeAsync(
        User approver, Guid actionId, string note) =>
        DecideFromOwnScopeAsync(approver, actionId, approve: true, note);

    private async Task<OperationResult<ActionRequest>> DecideFromOwnScopeAsync(
        User actor, Guid actionId, bool approve, string? note = null)
    {
        using IServiceScope scope = _factory.Services.CreateScope();

        var service = scope.ServiceProvider.GetRequiredService<IActionRequestService>();
        var user = new CurrentUser(
            actor.Id, actor.Username, actor.Role, actor.HasElevatedSql, actor.HasHardwareActuation);

        return approve
            ? await service.ApproveAsync(
                user, actionId, new ApproveActionRequest { Note = note }, CancellationToken.None)
            : await service.DenyAsync(
                user, actionId,
                new DenyActionRequest { Reason = "Clinic is mid-session." },
                CancellationToken.None);
    }

    private static async Task<Guid> RequestAsync(
        HttpClient client, Guid cabinetId, string ticket = "SUP-1000")
    {
        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/actions", StopSpooler(cabinetId, ticket));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        return (await response.ReadAsync<ActionRequestView>())!.Id;
    }

    private static CreateActionRequest StopSpooler(Guid cabinetId, string ticket) => new()
    {
        Action = ActionName.StopService,
        CabinetId = cabinetId,
        Parameters = new Dictionary<string, string> { ["serviceName"] = "Spooler" },
        Reason = "Print queue is wedged.",
        TicketReference = ticket,
    };
#endif

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
