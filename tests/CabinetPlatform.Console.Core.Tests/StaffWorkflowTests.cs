using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Data;
using CommunityToolkit.Mvvm.Input;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class StaffWorkflowTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public StaffWorkflowTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Signout_during_committed_creation_does_not_restore_staff_state()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        var session = new SessionStore();
        var gate = new CommittedCreateGate { InnerHandler = _host.Server.CreateHandler() };
        using var http = new HttpClient(new BearerTokenHandler(session) { InnerHandler = gate }) { BaseAddress = new Uri("http://localhost") };
        var api = new ApiClient(http, session);
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var vm = new StaffViewModel(api, session, new RecordingLiveRegionAnnouncer())
        { Username = "late-" + Guid.NewGuid().ToString("N")[..12], DisplayName = "Late response", SelectedTier = Role.Tier1 };
        var pending = vm.CreateCommand.ExecuteAsync("Temporary!Password42");
        await gate.Committed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        session.SignOut();
        vm.Reset();
        gate.Release.TrySetResult();
        await pending;
        Assert.Empty(vm.Outcome);
        Assert.Empty(vm.Users);
        Assert.Empty(vm.Username);
    }

    private sealed class CommittedCreateGate : DelegatingHandler
    {
        public TaskCompletionSource Committed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var response = await base.SendAsync(request, ct);
            if ((request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/api/users") ||
                (request.Method == HttpMethod.Patch && request.RequestUri!.AbsolutePath.StartsWith("/api/users/", StringComparison.Ordinal)))
            {
                response.EnsureSuccessStatusCode();
                Committed.TrySetResult();
                await Release.Task;
            }
            return response;
        }
    }

    [Fact]
    public async Task Signout_during_committed_disable_does_not_restore_staff_state()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        var target = await _host.CreateUserAsync(Role.Tier1, Guid.NewGuid().ToString());
        var session = new SessionStore();
        var gate = new CommittedCreateGate { InnerHandler = _host.Server.CreateHandler() };
        using var http = new HttpClient(new BearerTokenHandler(session) { InnerHandler = gate }) { BaseAddress = new Uri("http://localhost") };
        var api = new ApiClient(http, session);
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var vm = new StaffViewModel(api, session, new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync();
        vm.SelectedUser = vm.Users.Single(u => u.Id == target.Id);
        vm.DisableConfirmed = true;
        var pending = vm.DisableCommand.ExecuteAsync(null);
        await gate.Committed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        session.SignOut(); vm.Reset(); gate.Release.TrySetResult();
        await pending;
        Assert.Empty(vm.Outcome);
        Assert.Empty(vm.Users);
        Assert.Null(vm.SelectedUser);
    }

    [Fact]
    public async Task Supervisor_can_change_support_tier_and_disable_the_exact_selected_account()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        string staffName = "disable-" + Guid.NewGuid().ToString("N")[..12];
        var staff = await _host.CreateUserAsync(Role.Tier2, staffName);
        var (support, _) = _host.CreateConsole();
        await support.LoginAsync(new LoginRequest { Username = staffName, Password = ConsoleTestHost.KnownPassword }, default);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var vm = new StaffViewModel(api, session, new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync();
        vm.SelectedUser = vm.Users.Single(u => u.Id == staff.Id);
        var update = typeof(StaffViewModel).GetProperty("SaveTierCommand");
        Assert.NotNull(update);
        vm.SelectedTier = Role.Tier1;
        await ((IAsyncRelayCommand)update.GetValue(vm)!).ExecuteAsync(null);
        Assert.False(vm.HasError, vm.ErrorMessage);
        Assert.Equal(Role.Tier1, vm.Users.Single(u => u.Id == staff.Id).Role);
        vm.SelectedUser = vm.Users.Single(u => u.Id == staff.Id);
        typeof(StaffViewModel).GetProperty("DisableConfirmed")!.SetValue(vm, true);
        var disable = (IAsyncRelayCommand)typeof(StaffViewModel).GetProperty("DisableCommand")!.GetValue(vm)!;
        await disable.ExecuteAsync(null);
        Assert.False(vm.HasError, vm.ErrorMessage);
        Assert.False(vm.Users.Single(u => u.Id == staff.Id).IsActive);
        Assert.Null(vm.SelectedUser);
        Assert.False(disable.CanExecute(null));
        await Assert.ThrowsAsync<ApiException>(() => support.GetCabinetsAsync(new(), default));
        var (fresh, _) = _host.CreateConsole();
        await Assert.ThrowsAsync<ApiException>(() => fresh.LoginAsync(new LoginRequest { Username = staffName, Password = ConsoleTestHost.KnownPassword }, default));
    }

    [Fact]
    public async Task Supervisor_create_command_persists_selected_tier_and_requires_password_change()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var type = typeof(ShellViewModel).Assembly.GetType("CabinetPlatform.Console.Core.ViewModels.StaffViewModel");
        Assert.NotNull(type);
        dynamic vm = Activator.CreateInstance(type, api, session, new RecordingLiveRegionAnnouncer())!;
        string staffName = "staff-" + Guid.NewGuid().ToString("N")[..12];
        vm.Username = staffName;
        vm.DisplayName = "Office Support";
        vm.SelectedTier = Role.Tier2;
        var command = (IAsyncRelayCommand)vm.CreateCommand;
        Assert.True(command.CanExecute("Temporary!Password42"));
        await command.ExecuteAsync("Temporary!Password42");
        Assert.False((bool)vm.HasError, (string?)vm.ErrorMessage);
        using var scope = _host.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var user = await db.Users.AsNoTracking().SingleAsync(u => u.Username == staffName);
        Assert.Equal(Role.Tier2, user.Role);
        Assert.True(user.MustChangePassword);
        Assert.True(user.IsActive);
        Assert.NotEmpty(user.PasswordHash);
        var (support, _) = _host.CreateConsole();
        var login = await support.LoginAsync(new LoginRequest { Username = staffName, Password = "Temporary!Password42" }, default);
        Assert.True(login.MustChangePassword);
        await Assert.ThrowsAsync<ApiException>(() => support.GetCabinetsAsync(new(), default));
    }
}
