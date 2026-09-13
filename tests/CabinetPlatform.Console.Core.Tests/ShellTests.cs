using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// The shell: role gating, sign-out, and the response to an expired token.
/// </summary>
public sealed class ShellTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;

    public ShellTests(ConsoleTestHost host) => _host = host;

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];

    private async Task<(ShellViewModel Shell, SessionStore Session, ApiClient Api,
        RecordingLiveRegionAnnouncer Announcer)> SignedInShellAsync(Role role)
    {
        string username = Unique(role.ToString().ToLowerInvariant());
        await _host.CreateUserAsync(role, username);

        (ApiClient api, SessionStore session) = _host.CreateConsole();

        await api.LoginAsync(
            new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword },
            CancellationToken.None);

        RecordingLiveRegionAnnouncer announcer = new();
        TimeProvider time = TimeProvider.System;

        var invoker = new ActionInvoker(api, ScriptedActionDialog.Accepting(), announcer, session);

        var shell = new ShellViewModel(
            new CabinetListViewModel(api, announcer, time),
            new CabinetFinderViewModel(api, announcer, time),
            new MachineTabViewModel(api, invoker, session, announcer, time),
            new CabinetTabViewModel(),
            new AuditTabViewModel(api, announcer, time),
            new FleetTabViewModel(api, announcer, time),
            new ApprovalsViewModel(api, ScriptedApprovalDialog.Accepting(), session, announcer, time),
            session,
            announcer);

        return (shell, session, api, announcer);
    }

    [Fact]
    public async Task Persistent_search_opens_the_results_view()
    {
        var (shell, _, _, _) = await SignedInShellAsync(Role.Tier2);
        shell.CurrentView = ShellView.Cabinets;
        shell.Finder.Term = "console-search-test";
        await shell.Finder.SearchCommand.ExecuteAsync(null);
        Assert.Equal(ShellView.Find, shell.CurrentView);
    }

    [Fact]
    public async Task Starting_a_session_loads_the_list_and_the_fleet_and_announces_the_result()
    {
        await _host.CreateCabinetAsync($"SHELL-{Unique("a")[..6]}");

        (ShellViewModel shell, _, _, RecordingLiveRegionAnnouncer announcer) =
            await SignedInShellAsync(Role.Supervisor);

        await shell.StartSessionAsync();

        Assert.True(shell.IsSignedIn);
        Assert.Equal(ShellView.Cabinets, shell.CurrentView);
        Assert.NotEmpty(shell.Cabinets.Cabinets);
        Assert.NotNull(shell.Fleet.Summary);
        Assert.True(announcer.Any("Signed in as"));
    }

    [Fact]
    public async Task Selecting_a_cabinet_loads_its_machine_tab()
    {
        string clientName = Unique("SelClient");
        Cabinet cabinet = await _host.CreateCabinetAsync($"SEL-{Unique("b")[..6]}", clientName);

        await _host.AddFullCheckInAsync(
            cabinet.Id,
            TestData.Payload(cabinet.MachineId, DateTimeOffset.UtcNow.AddMinutes(-2)),
            DateTimeOffset.UtcNow.AddMinutes(-2));

        (ShellViewModel shell, _, _, _) = await SignedInShellAsync(Role.Tier2);

        shell.Cabinets.ClientFilter = clientName;
        await shell.Cabinets.LoadAsync();

        // Selecting a row starts the detail load from an event handler; the
        // shell keeps that task so a caller can await it.
        await shell.PendingSelectionLoad;

        Assert.Equal(cabinet.Id, shell.Machine.CabinetId);
        Assert.True(shell.Machine.Overview.Availability.HasData);
        Assert.Equal(cabinet.Hostname, shell.Machine.Overview.Hostname);
    }

    /// <summary>
    /// Every rep is offered the approvals queue and the audit trail.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This replaces a test that asserted Tier 1 saw neither. Both are open to
    /// every authenticated rep now: any rep may approve another rep's request —
    /// what none may do is approve their own — and the audit trail is the
    /// control that replaces case scoping, which only works if everybody can
    /// see it.
    /// </para>
    /// <para>
    /// The properties stay on the shell rather than being replaced by literals
    /// in the markup, so tightening this later is one change in one place.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData(Role.Tier1)]
    [InlineData(Role.Tier2)]
    [InlineData(Role.Supervisor)]
    public async Task Every_rep_is_offered_the_queue_and_the_trail(Role role)
    {
        (ShellViewModel shell, _, _, _) = await SignedInShellAsync(role);

        Assert.True(shell.CanSeeApprovals);
        Assert.True(shell.CanSeeAudit);
    }

    [Fact]
    public async Task Signing_out_discards_the_token_clears_the_screens_and_asks_for_a_sign_in()
    {
        await _host.CreateCabinetAsync($"OUT-{Unique("c")[..6]}");

        (ShellViewModel shell, SessionStore session, _, RecordingLiveRegionAnnouncer announcer) =
            await SignedInShellAsync(Role.Supervisor);

        await shell.StartSessionAsync();
        await shell.PendingSelectionLoad;
        Assert.NotEmpty(shell.Cabinets.Cabinets);
        Assert.NotNull(shell.Machine.Path);
        shell.Audit.SelectedCabinet = shell.Audit.Cabinets.First();
        shell.Cabinets.SearchText = "prior operator search";
        shell.Machine.Processes.FilterText = "prior process filter";

        List<SignInReason> asked = new();
        shell.SignInRequired += (_, reason) => asked.Add(reason);

        shell.SignOutCommand.Execute(null);

        Assert.False(session.IsSignedIn);
        Assert.Null(session.AccessToken);
        Assert.Empty(shell.Cabinets.Cabinets);
        Assert.Null(shell.Machine.Path);
        Assert.Null(shell.Machine.CabinetId);
        Assert.Empty(shell.Machine.ActionHistory);
        Assert.All(shell.Machine.Sections, s => Assert.Empty(s.Actions));
        Assert.Null(shell.Fleet.Summary);
        Assert.Empty(shell.Fleet.Sites);
        Assert.Empty(shell.Audit.Cabinets);
        Assert.Null(shell.Audit.SelectedCabinet);
        Assert.Empty(shell.Cabinets.SearchText);
        Assert.Empty(shell.Machine.Processes.FilterText);
        Assert.Equal(SignInReason.SignedOut, Assert.Single(asked));
        Assert.True(announcer.Any("token has been discarded"));
    }

    /// <summary>
    /// A rejected token takes the user back to sign-in, rather than surfacing as
    /// a server error they will try to diagnose.
    /// </summary>
    [Fact]
    public async Task An_expired_token_asks_for_a_new_sign_in_rather_than_reporting_a_fault()
    {
        (ShellViewModel shell, SessionStore session, _, _) =
            await SignedInShellAsync(Role.Supervisor);

        await shell.StartSessionAsync();

        List<SignInReason> asked = new();
        shell.SignInRequired += (_, reason) => asked.Add(reason);

        // Replace the token with one the server will reject. This is what a
        // lapsed token looks like from the console's side.
        session.SignIn(
            "not.a.valid.token",
            DateTimeOffset.UtcNow.AddMinutes(30),
            "not.a.valid.refresh.token",
            "Someone",
            Role.Supervisor,
            mustChangePassword: false);

        await shell.Cabinets.LoadAsync();

        Assert.Equal(ApiFailure.SessionExpired, shell.Cabinets.LastFailure);
        Assert.Equal(SignInReason.SessionExpired, Assert.Single(asked));
        Assert.False(session.IsSignedIn);
    }

    [Fact]
    public async Task The_approval_badge_counts_only_what_this_user_can_act_on()
    {
        Cabinet cabinet = await _host.CreateCabinetAsync($"BDG-{Unique("d")[..6]}");

        // A request from somebody else: approvable, so it counts.
        string requesterName = Unique("badgereq");
        await _host.CreateUserAsync(Role.Tier2, requesterName);

        (ApiClient requesterApi, _) = _host.CreateConsole();
        await requesterApi.LoginAsync(
            new LoginRequest { Username = requesterName, Password = ConsoleTestHost.KnownPassword },
            CancellationToken.None);

        await requesterApi.CreateActionAsync(
            new Contracts.Actions.CreateActionRequest
            {
                Action = ActionName.StopService,
                CabinetId = cabinet.Id,
                Reason = "Controller wedged",
                TicketReference = "SUP-4001",
                Parameters = new Dictionary<string, string> { ["serviceName"] = "MashuraDispenseController" }
            },
            CancellationToken.None);

        (ShellViewModel shell, _, ApiClient approverApi, _) =
            await SignedInShellAsync(Role.Supervisor);

        // And one of the approver's own, which must not count towards the badge.
        await approverApi.CreateActionAsync(
            new Contracts.Actions.CreateActionRequest
            {
                Action = ActionName.StopService,
                CabinetId = cabinet.Id,
                Reason = "Second look at the controller",
                TicketReference = "SUP-4002",
                Parameters = new Dictionary<string, string> { ["serviceName"] = "MashuraDispenseController" }
            },
            CancellationToken.None);

        await shell.Approvals.LoadAsync();

        Assert.True(shell.Approvals.OwnRequestCount >= 1);
        Assert.DoesNotContain(shell.Approvals.Queue, r => r.IsOwnRequest && r.CanDecide);

        // The badge is the actionable count, never the queue length.
        Assert.Equal(
            shell.Approvals.ActionableCount > 0 ? shell.Approvals.ActionableCount : null,
            shell.ApprovalBadge);

        Assert.True(shell.Approvals.ActionableCount < shell.Approvals.Queue.Count);
    }

    [Fact]
    public async Task Deactivating_cancels_work_in_flight_without_throwing()
    {
        (ShellViewModel shell, _, _, _) = await SignedInShellAsync(Role.Tier1);

        Task loading = shell.Cabinets.LoadAsync();
        shell.DeactivateAll();

        await loading;

        // Cancellation is not an error, and must not be reported as one.
        Assert.Null(shell.Cabinets.ErrorMessage);
    }

    [Fact]
    public void The_cabinet_tab_is_an_honest_empty_state_with_no_fabricated_readings()
    {
        var tab = new CabinetTabViewModel();

        Assert.Equal("No cabinet data collected yet.", tab.EmptyStateHeading);
        Assert.Contains("nothing has been substituted", tab.EmptyStateDetail);
        Assert.Contains("no drawer, lock or cubie controls", tab.NoActuationNote);

        // Every string on the tab is explanation. None of them is a number
        // pretending to be a sensor reading.
        foreach (string text in new[]
                 {
                     tab.EmptyStateHeading, tab.EmptyStateDetail,
                     tab.WhyThisTabExists, tab.NoActuationNote
                 })
        {
            Assert.DoesNotContain("°C", text);
            Assert.DoesNotContain("%", text);
        }
    }
}
