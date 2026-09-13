using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Reflection;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Registrations;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests;

/// <summary>Real registration HTTP, persisted agent state, supervisor UI commands and API authorization.</summary>
public sealed class EnrollmentFlowTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public EnrollmentFlowTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Worker_registers_automatically_and_restarts_into_only_the_explicitly_accepted_identity()
    {
        var (api, session, vm) = await ConsoleAsync(Role.Supervisor);
        string machine = Unique();
        using var agent = Agent(machine);
        string directory = Path.Combine(Path.GetTempPath(), "enrollment-" + Guid.NewGuid().ToString("N"));
        try
        {
            var options = TestOptions.Create(new AgentOptions { StateDirectory = directory });
            FileAgentStateStore Store() => new(options, NullLogger<FileAgentStateStore>.Instance);
            var state = Store();
            var identity = new Identity(machine);
            var clock = new FixedClock(DateTimeOffset.UtcNow);
            var client = new ServerClient(new ClientFactory(agent), NullLogger<ServerClient>.Instance);
            RegistrationService Registration(IAgentStateStore store) => new(client, store, identity,
                new FakeWmiRepository(), clock, NullLogger<RegistrationService>.Instance);
            var collector = new ForbiddenCollector();
            var builder = new CheckInBuilder(new[] { collector }, identity, state, clock, NullLogger<CheckInBuilder>.Instance);
            // No explicit registration call: the installed service's real tick does it.
            using var worker = new Worker(builder, client, null!, Registration(state), null!, null!, state, options, NullLogger<Worker>.Instance);
            await Tick(worker);
            Assert.Equal(RegistrationStatus.Pending, Store().Load().RegistrationStatus);
            Assert.False(Store().Load().IsApproved);
            await Tick(worker);
            Assert.Equal(1, await Db(db => db.PendingRegistrations.CountAsync(r => r.MachineId == machine)));
            Assert.False(await Db(db => db.Cabinets.AnyAsync(c => c.MachineId == machine)));

            await vm.LoadAsync();
            vm.SelectedRegistration = Assert.Single(vm.Queue, r => r.MachineId == machine);
            Guid registrationId = vm.SelectedRegistration.Id;
            vm.ClientName = "Enrollment client";
            vm.SiteName = Unique();
            vm.CabinetRole = CabinetRole.Standalone;
            Assert.False(vm.AcceptCommand.CanExecute(null));
            vm.IdentityConfirmed = true;
            Assert.True(vm.AcceptCommand.CanExecute(null));
            await vm.AcceptCommand.ExecuteAsync(null);
            Assert.False(vm.HasError, vm.ErrorMessage);
            Assert.DoesNotContain(vm.Queue, r => r.Id == registrationId);

            var cabinet = await Db(db => db.Cabinets.AsNoTracking().SingleAsync(c => c.MachineId == machine));
            Assert.True(cabinet.IsActive);
            Assert.Equal(session.UserId, cabinet.ApprovedByUserId);
            Assert.NotEqual(registrationId, cabinet.Id);
            Assert.True(await Registration(Store()).EnsureRegisteredAsync(CancellationToken.None));
            Assert.Equal(cabinet.Id, Store().Load().CabinetId);
            Assert.True(await Registration(Store()).EnsureRegisteredAsync(CancellationToken.None));
            Assert.Equal(1, await Db(db => db.Cabinets.CountAsync(c => c.MachineId == machine)));
            Assert.Equal(1, await Db(db => db.PendingRegistrations.CountAsync(r => r.MachineId == machine)));
            var accepted = await client.CheckInAsync(builder.BuildIdentityOnly(), CheckInTier.Heartbeat, CancellationToken.None);
            Assert.Equal(CheckInOutcome.Accepted, accepted.Outcome);
            Assert.Equal(cabinet.Id, accepted.CabinetId);

            // A repeated supervisor decision cannot create another cabinet.
            var conflict = await Assert.ThrowsAsync<ApiException>(() => api.ApproveRegistrationAsync(registrationId,
                Approval(), CancellationToken.None));
            Assert.Equal(ApiFailure.Conflict, conflict.Failure);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task Pending_and_rejected_agents_cannot_ingest_collect_or_report_and_retries_do_not_reset_rejection()
    {
        var (_, _, vm) = await ConsoleAsync(Role.Supervisor);
        string machine = Unique();
        using var agent = Agent(machine);
        await Register(agent, machine);
        await AssertUnapproved(agent, machine);
        await vm.LoadAsync();
        vm.SelectedRegistration = Assert.Single(vm.Queue, r => r.MachineId == machine);
        Guid registration = vm.SelectedRegistration.Id;
        vm.IdentityConfirmed = true;
        Assert.False(vm.RejectCommand.CanExecute(null));
        vm.Reason = "Independently verified as not a fleet machine.";
        await vm.RejectCommand.ExecuteAsync(null);
        Assert.False(vm.HasError, vm.ErrorMessage);
        Assert.DoesNotContain(vm.Queue, r => r.Id == registration);
        for (int retry = 0; retry < 3; retry++)
        {
            using var restarted = Agent(machine);
            var response = await Register(restarted, machine);
            Assert.Equal(RegistrationStatus.Rejected, response.Status);
            Assert.Null(response.CabinetId);
        }
        await AssertUnapproved(agent, machine);
        Assert.Equal(1, await Db(db => db.PendingRegistrations.CountAsync(r => r.MachineId == machine)));
        Assert.False(await Db(db => db.Cabinets.AnyAsync(c => c.MachineId == machine)));
        vm.StatusFilter = RegistrationStatus.Rejected;
        await vm.RefreshCommand.ExecuteAsync(null);
        vm.SelectedRegistration = Assert.Single(vm.Queue, r => r.Id == registration);
        vm.IdentityConfirmed = true;
        vm.ClientName = vm.SiteName = "No readmission";
        vm.CabinetRole = CabinetRole.Standalone;
        Assert.False(vm.AcceptCommand.CanExecute(null));
        Assert.False(vm.RejectCommand.CanExecute(null));
    }

    [Theory]
    [InlineData(Role.Tier1)]
    [InlineData(Role.Tier2)]
    public async Task Non_supervisors_are_denied_by_both_ui_and_real_API(Role role)
    {
        var (api, _, vm) = await ConsoleAsync(role);
        string machine = Unique();
        using var agent = Agent(machine);
        await Register(agent, machine);
        Guid id = await Db(db => db.PendingRegistrations.Where(r => r.MachineId == machine).Select(r => r.Id).SingleAsync());
        Assert.False(vm.IsSupervisor);
        Assert.False(vm.RefreshCommand.CanExecute(null));
        Assert.False(vm.AcceptCommand.CanExecute(null));
        Assert.False(vm.RejectCommand.CanExecute(null));
        Assert.Equal(ApiFailure.Forbidden, (await Assert.ThrowsAsync<ApiException>(() => api.GetRegistrationsAsync(new RegistrationQuery(), CancellationToken.None))).Failure);
        Assert.Equal(ApiFailure.Forbidden, (await Assert.ThrowsAsync<ApiException>(() => api.ApproveRegistrationAsync(id, Approval(), CancellationToken.None))).Failure);
        Assert.Equal(ApiFailure.Forbidden, (await Assert.ThrowsAsync<ApiException>(() => api.RejectRegistrationAsync(id, new RejectRegistrationRequest { Reason = "Not permitted" }, CancellationToken.None))).Failure);
        Assert.Equal(RegistrationStatus.Pending, await Db(db => db.PendingRegistrations.Where(r => r.Id == id).Select(r => r.Status).SingleAsync()));
        Assert.False(await Db(db => db.Cabinets.AnyAsync(c => c.MachineId == machine)));
    }

    [Fact]
    public async Task Stale_queue_decision_shows_conflict_and_requires_a_fresh_identity_confirmation()
    {
        var (api, _, vm) = await ConsoleAsync(Role.Supervisor);
        string machine = Unique();
        using var agent = Agent(machine);
        await Register(agent, machine);
        await vm.LoadAsync();
        vm.SelectedRegistration = Assert.Single(vm.Queue, r => r.MachineId == machine);
        Guid id = vm.SelectedRegistration.Id;
        vm.ClientName = vm.SiteName = "stale";
        vm.CabinetRole = CabinetRole.Standalone;
        vm.IdentityConfirmed = true;
        await api.RejectRegistrationAsync(id, new RejectRegistrationRequest { Reason = "Another supervisor decided first" }, CancellationToken.None);
        await vm.AcceptCommand.ExecuteAsync(null);
        Assert.Equal(ApiFailure.Conflict, vm.LastFailure);
        Assert.Null(vm.SelectedRegistration);
        Assert.False(vm.IdentityConfirmed);
        Assert.False(vm.AcceptCommand.CanExecute(null));
        Assert.Contains("Refresh", vm.Outcome);
        Assert.Empty(vm.Queue);
        await vm.RefreshCommand.ExecuteAsync(null);
        Assert.DoesNotContain(vm.Queue, r => r.Id == id);
        Assert.False(await Db(db => db.Cabinets.AnyAsync(c => c.MachineId == machine)));
    }

    [Fact]
    public async Task Lost_approval_response_requires_refresh_and_never_silently_resubmits()
    {
        var (_, session, _) = await ConsoleAsync(Role.Supervisor);
        var drop = new LoseApprovalResponse { InnerHandler = _host.Server.CreateHandler() };
        using var http = new HttpClient(drop) { BaseAddress = new Uri("https://localhost/") };
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", session.AccessToken);
        var vm = new RegistrationsViewModel(new ApiClient(http, session), session, new RecordingLiveRegionAnnouncer());
        string machine = Unique();
        using var agent = Agent(machine);
        await Register(agent, machine);
        await vm.LoadAsync();
        vm.SelectedRegistration = Assert.Single(vm.Queue, r => r.MachineId == machine);
        vm.ClientName = "Lost response client";
        vm.SiteName = machine;
        vm.CabinetRole = CabinetRole.Standalone;
        vm.IdentityConfirmed = true;
        await vm.AcceptCommand.ExecuteAsync(null);
        Assert.Equal(ApiFailure.Unreachable, vm.LastFailure);
        Assert.Equal(1, drop.Approvals);
        Assert.Empty(vm.Queue);
        Assert.False(vm.AcceptCommand.CanExecute(null));
        Assert.Equal(1, await Db(db => db.Cabinets.CountAsync(c => c.MachineId == machine)));
        await vm.RefreshCommand.ExecuteAsync(null);
        Assert.DoesNotContain(vm.Queue, r => r.MachineId == machine);
        Assert.Equal(1, drop.Approvals);
        Assert.Equal(RegistrationStatus.Approved, (await Register(agent, machine)).Status);
    }

    [Fact]
    public async Task Identical_hostnames_do_not_merge_registrations_or_approve_the_other_machine()
    {
        var (_, _, vm) = await ConsoleAsync(Role.Supervisor);
        string first = Unique(), second = Unique();
        using var a = Agent(first);
        using var b = Agent(second);
        await Register(a, first);
        await Register(b, second);
        await vm.LoadAsync();
        var selected = Assert.Single(vm.Queue, r => r.MachineId == first);
        var other = Assert.Single(vm.Queue, r => r.MachineId == second);
        Assert.Equal(selected.Hostname, other.Hostname);
        Assert.NotEqual(selected.Id, other.Id);
        vm.SelectedRegistration = selected;
        vm.ClientName = "Duplicate hostname client";
        vm.SiteName = first;
        vm.CabinetRole = CabinetRole.Standalone;
        vm.IdentityConfirmed = true;
        await vm.AcceptCommand.ExecuteAsync(null);
        Assert.False(vm.HasError, vm.ErrorMessage);
        var approved = await Register(a, first);
        var pending = await Register(b, second);
        Assert.Equal(RegistrationStatus.Approved, approved.Status);
        Assert.Equal(RegistrationStatus.Pending, pending.Status);
        Assert.Null(pending.CabinetId);
        Assert.Equal(approved.CabinetId, await Db(db => db.Cabinets.Where(c => c.MachineId == first).Select(c => c.Id).SingleAsync()));
        Assert.False(await Db(db => db.Cabinets.AnyAsync(c => c.MachineId == second)));
    }

    private sealed class LoseApprovalResponse : DelegatingHandler
    {
        public int Approvals;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var response = await base.SendAsync(request, ct);
            if (request.RequestUri!.AbsolutePath.EndsWith("/approve", StringComparison.Ordinal))
            {
                Approvals++;
                Assert.True(response.IsSuccessStatusCode);
                response.Dispose();
                throw new HttpRequestException("Synthetic lost response after server commit");
            }
            return response;
        }
    }

    private async Task AssertUnapproved(HttpClient agent, string machine)
    {
        int before = await Db(db => db.Heartbeats.CountAsync());
        var payload = new CheckInPayload { MachineId = machine, AgentVersion = "test", CollectedAtUtc = DateTimeOffset.UtcNow };
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.PostAsJsonAsync("api/agent/checkin", payload, ContractJson.CreateOptions())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.PostAsJsonAsync("api/agent/checkin/full", payload, ContractJson.CreateOptions())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.GetAsync("api/agent/actions")).StatusCode);
        var result = new ActionResultDto { RequestId = Guid.NewGuid(), Status = ActionStatus.Succeeded,
            StartedAtUtc = DateTimeOffset.UtcNow, CompletedAtUtc = DateTimeOffset.UtcNow, Output = "synthetic" };
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.PostAsJsonAsync("api/agent/actions/result", result, ContractJson.CreateOptions())).StatusCode);
        Assert.Equal(before, await Db(db => db.Heartbeats.CountAsync()));
    }

    private async Task<(ApiClient Api, SessionStore Session, RegistrationsViewModel Vm)> ConsoleAsync(Role role)
    {
        string username = Unique();
        await _host.CreateUserAsync(role, username);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, CancellationToken.None);
        return (api, session, new RegistrationsViewModel(api, session, new RecordingLiveRegionAnnouncer()));
    }
    private HttpClient Agent(string machine)
    {
        var client = _host.CreateClient();
        client.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
        client.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", machine);
        return client;
    }
    private static async Task<RegistrationResponse> Register(HttpClient agent, string machine)
    {
        var response = await agent.PostAsJsonAsync("api/agent/register", new RegistrationRequest
        { MachineId = machine, Hostname = "SAME-HOSTNAME", AgentVersion = "test", OsVersion = "Synthetic Windows" }, ContractJson.CreateOptions());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<RegistrationResponse>(ContractJson.CreateOptions()))!;
    }
    private async Task<T> Db<T>(Func<SupportDbContext, Task<T>> work)
    {
        using var scope = _host.Services.CreateScope();
        return await work(scope.ServiceProvider.GetRequiredService<SupportDbContext>());
    }
    private static ApproveRegistrationRequest Approval() => new() { ClientName = "Enrollment client", SiteName = "Site", Role = CabinetRole.Standalone };
    private static string Unique() => "enroll-" + Guid.NewGuid().ToString("N")[..16];
    private static Task Tick(Worker worker) => (Task)typeof(Worker).GetMethod("TickAsync", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(worker, new object[] { CancellationToken.None })!;
    private sealed class Identity(string machine) : IMachineIdentityProvider { public string GetMachineId() => machine; }
    private sealed class ClientFactory(HttpClient client) : IHttpClientFactory { public HttpClient CreateClient(string name) => client; }
    private sealed class ForbiddenCollector : ICollector
    {
        public bool RunsOnHeartbeat => true;
        public string SectionName => CollectorSections.System;
        public Task CollectAsync(CheckInDraft draft, CheckInTier tier, CancellationToken token) => throw new InvalidOperationException("Pending agents must not collect diagnostics");
    }
}
