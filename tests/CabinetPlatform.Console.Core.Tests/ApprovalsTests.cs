using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// The approval queue, including the behaviour the brief singles out: the
/// user's own requests shown dimmed with a visible reason rather than hidden.
/// </summary>
public sealed class ApprovalsTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;

    public ApprovalsTests(ConsoleTestHost host) => _host = host;

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];

    private async Task<(ApiClient Api, SessionStore Session)> SignInAsync(Role role, string username)
    {
        await _host.CreateUserAsync(role, username);

        (ApiClient api, SessionStore session) = _host.CreateConsole();

        await api.LoginAsync(
            new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword },
            CancellationToken.None);

        return (api, session);
    }

    private static ApprovalsViewModel Build(
        ApiClient api,
        SessionStore session,
        IApprovalDecisionDialog dialog,
        RecordingLiveRegionAnnouncer announcer) =>
        new(api, dialog, session, announcer, TimeProvider.System);

    /// <summary>
    /// Creates a request that needs approval, as the given user.
    /// </summary>
    private static Task<ActionRequestDto> RequestStopServiceAsync(ApiClient api, Guid cabinetId) =>
        api.CreateActionAsync(
            new CreateActionRequest
            {
                Action = ActionName.StopService,
                CabinetId = cabinetId,
                Reason = "Dispense controller wedged; bouncing it for ticket SUP-2001",
                TicketReference = "SUP-2001",
                Parameters = { ["serviceName"] = "MashuraDispenseController" }
            },
            CancellationToken.None);

    [Fact]
    public async Task Another_persons_request_is_actionable_and_can_be_approved()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"CUBEX-{Unique("a")[..8]}");

        (ApiClient requesterApi, _) = await SignInAsync(Role.Tier2, Unique("req"));
        ActionRequestDto created = await RequestStopServiceAsync(requesterApi, cabinet.Id);

        Assert.Equal(ActionRequestStatus.PendingApproval, created.Status);

        (ApiClient approverApi, SessionStore approverSession) =
            await SignInAsync(Role.Tier2, Unique("app"));

        RecordingLiveRegionAnnouncer announcer = new();
        ScriptedApprovalDialog dialog = ScriptedApprovalDialog.Accepting();

        ApprovalsViewModel approvals = Build(approverApi, approverSession, dialog, announcer);

        await approvals.LoadAsync();

        ActionRow row = approvals.Queue.Single(r => r.Id == created.Id);

        Assert.True(row.CanDecide);
        Assert.False(row.IsOwnRequest);
        Assert.Null(row.UnavailableReason);
        Assert.Equal("Awaiting approval", row.Status.Label);
        Assert.Equal("SUP-2001", row.Ticket);

        approvals.SelectedRequest = row;
        await approvals.ApproveCommand.ExecuteAsync(null);

        Assert.Null(approvals.ErrorMessage);
        Assert.True(announcer.Any("Approved"));

        ActionRequestDto after = await approverApi.GetActionAsync(created.Id, CancellationToken.None);
        Assert.Equal(ActionRequestStatus.Approved, after.Status);
        Assert.Equal(approverSession.UserId, after.ApprovedByUserId);
    }

    /// <summary>
    /// The behaviour the brief asks for by name. The server omits the caller's
    /// own requests from the approvals endpoint; the console fetches them
    /// separately and shows them greyed with the reason, so the four-eyes rule
    /// is legible instead of looking like a lost request.
    /// </summary>
    [Fact]
    public async Task My_own_request_appears_dimmed_with_a_visible_reason_rather_than_hidden()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"CUBEX-{Unique("b")[..8]}");

        (ApiClient api, SessionStore session) = await SignInAsync(Role.Tier2, Unique("self"));

        ActionRequestDto mine = await RequestStopServiceAsync(api, cabinet.Id);

        ApprovalsViewModel approvals = Build(
            api, session, ScriptedApprovalDialog.Accepting(), new RecordingLiveRegionAnnouncer());

        await approvals.LoadAsync();

        ActionRow row = Assert.Single(approvals.Queue, r => r.Id == mine.Id);

        Assert.True(row.IsOwnRequest);
        Assert.False(row.CanDecide);
        Assert.NotNull(row.UnavailableReason);
        Assert.Contains("cannot approve your own request",
            row.UnavailableReason!, StringComparison.OrdinalIgnoreCase);

        // It is in the queue, and it is not counted among the actionable rows.
        // Scoped to this request rather than to the whole queue: the fixture's
        // database is shared across this class, so requests raised by other
        // tests' users are legitimately approvable by this one.
        Assert.Contains(approvals.Queue, r => r.Id == mine.Id && r.IsOwnRequest);
        Assert.DoesNotContain(approvals.Queue, r => r.Id == mine.Id && r.CanDecide);
        Assert.True(approvals.OwnRequestCount >= 1);
        Assert.Contains("cannot be approved by you", approvals.QueueSummary);
    }

    [Fact]
    public async Task The_server_refuses_self_approval_even_if_the_console_is_bypassed()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"CUBEX-{Unique("c")[..8]}");

        (ApiClient api, _) = await SignInAsync(Role.Supervisor, Unique("bypass"));

        ActionRequestDto mine = await RequestStopServiceAsync(api, cabinet.Id);

        // Straight at the API, as if the console's greyed button had been
        // worked around. The rule is the server's, not the UI's.
        ApiException refusal = await Assert.ThrowsAsync<ApiException>(() =>
            api.ApproveActionAsync(mine.Id, new ApproveActionRequest(), CancellationToken.None));

        Assert.Equal(ApiFailure.Forbidden, refusal.Failure);
        Assert.Contains("cannot approve an action you requested",
            refusal.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Denying_a_request_records_the_reason_and_stops_it_running()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"CUBEX-{Unique("d")[..8]}");

        (ApiClient requesterApi, _) = await SignInAsync(Role.Tier2, Unique("dreq"));
        ActionRequestDto created = await RequestStopServiceAsync(requesterApi, cabinet.Id);

        (ApiClient approverApi, SessionStore approverSession) =
            await SignInAsync(Role.Supervisor, Unique("dapp"));

        RecordingLiveRegionAnnouncer announcer = new();

        ApprovalsViewModel approvals = Build(
            approverApi, approverSession,
            ScriptedApprovalDialog.Accepting("Clinic is mid-session; not stopping this now."),
            announcer);

        await approvals.LoadAsync();

        approvals.SelectedRequest = approvals.Queue.Single(r => r.Id == created.Id);
        await approvals.DenyCommand.ExecuteAsync(null);

        Assert.Null(approvals.ErrorMessage);
        Assert.True(announcer.Any("Denied"));

        ActionRequestDto after = await approverApi.GetActionAsync(created.Id, CancellationToken.None);
        Assert.Equal(ActionRequestStatus.Denied, after.Status);
    }

    [Fact]
    public async Task Cancelling_the_decision_dialog_changes_nothing()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"CUBEX-{Unique("e")[..8]}");

        (ApiClient requesterApi, _) = await SignInAsync(Role.Tier2, Unique("creq"));
        ActionRequestDto created = await RequestStopServiceAsync(requesterApi, cabinet.Id);

        (ApiClient approverApi, SessionStore approverSession) =
            await SignInAsync(Role.Tier2, Unique("capp"));

        ApprovalsViewModel approvals = Build(
            approverApi, approverSession, ScriptedApprovalDialog.Cancelling(),
            new RecordingLiveRegionAnnouncer());

        await approvals.LoadAsync();

        approvals.SelectedRequest = approvals.Queue.Single(r => r.Id == created.Id);
        await approvals.ApproveCommand.ExecuteAsync(null);

        ActionRequestDto after = await approverApi.GetActionAsync(created.Id, CancellationToken.None);
        Assert.Equal(ActionRequestStatus.PendingApproval, after.Status);
    }

    [Fact]
    public async Task A_tier1_user_is_told_the_queue_is_not_theirs_rather_than_shown_an_empty_grid()
    {
        (ApiClient api, SessionStore session) = await SignInAsync(Role.Tier1, Unique("t1q"));

        ApprovalsViewModel approvals = Build(
            api, session, ScriptedApprovalDialog.Accepting(), new RecordingLiveRegionAnnouncer());

        await approvals.LoadAsync();

        Assert.True(approvals.IsForbidden);
        Assert.Empty(approvals.Queue);
        Assert.Contains("Tier 2", approvals.ForbiddenExplanation);
    }

    [Fact]
    public async Task Approving_something_already_decided_reports_the_conflict_and_reloads()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"CUBEX-{Unique("f")[..8]}");

        (ApiClient requesterApi, _) = await SignInAsync(Role.Tier2, Unique("freq"));
        ActionRequestDto created = await RequestStopServiceAsync(requesterApi, cabinet.Id);

        (ApiClient firstApi, SessionStore firstSession) =
            await SignInAsync(Role.Tier2, Unique("first"));
        (ApiClient secondApi, SessionStore secondSession) =
            await SignInAsync(Role.Tier2, Unique("second"));

        ApprovalsViewModel second = Build(
            secondApi, secondSession, ScriptedApprovalDialog.Accepting(),
            new RecordingLiveRegionAnnouncer());

        await second.LoadAsync();
        second.SelectedRequest = second.Queue.Single(r => r.Id == created.Id);

        // Somebody else decides while the row is on screen.
        await firstApi.ApproveActionAsync(created.Id, new ApproveActionRequest(), CancellationToken.None);

        await second.ApproveCommand.ExecuteAsync(null);

        Assert.NotNull(second.ErrorMessage);
        Assert.Contains("cannot be approved", second.ErrorMessage!, StringComparison.OrdinalIgnoreCase);

        // Reloaded, so the stale row is gone rather than sitting there with a
        // live button.
        Assert.DoesNotContain(second.Queue, r => r.Id == created.Id && r.CanDecide);
    }
}
