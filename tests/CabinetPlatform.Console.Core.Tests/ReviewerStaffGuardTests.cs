using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Audit;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class ReviewerStaffGuardTests
{
    [Theory]
    [InlineData(Role.Tier1)]
    [InlineData(Role.Tier2)]
    public async Task Support_guard_does_not_grant_lower_tier_administration(Role role)
    {
        using var host = new ConsoleTestHost();
        var actor = await host.CreateUserAsync(role, "review-actor");
        var target = await host.CreateUserAsync(Role.Tier1, "review-target");
        var (api, _) = host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = actor.Username, Password = ConsoleTestHost.KnownPassword }, default);
        var denied = await Assert.ThrowsAsync<ApiException>(() => api.UpdateUserAsync(target.Id,
            new UpdateUserRequest { SupportAccountsOnly = true, IsActive = false }, default));
        Assert.Equal(ApiFailure.Forbidden, denied.Failure);
        Assert.True(await host.WithDbAsync(db => db.Users.Where(u => u.Id == target.Id).Select(u => u.IsActive).SingleAsync()));
    }

    [Fact]
    public async Task Load_after_signout_notifies_false_before_authorization_guard()
    {
        using var host = new ConsoleTestHost();
        var actor = await host.CreateUserAsync(Role.Supervisor, "review-actor");
        var (api, session) = host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = actor.Username, Password = ConsoleTestHost.KnownPassword }, default);
        var vm = new StaffViewModel(api, session, new RecordingLiveRegionAnnouncer());
        bool bound = vm.IsSupervisor;
        vm.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(vm.IsSupervisor)) bound = vm.IsSupervisor; };
        session.SignOut(); vm.Reset(); await vm.LoadAsync();
        Assert.False(bound); Assert.False(vm.RefreshCommand.CanExecute(null)); Assert.Empty(vm.Users);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Invalid_role_denial_is_durable_with_and_without_support_guard(bool guarded)
    {
        using var host = new ConsoleTestHost();
        var admin = await host.CreateUserAsync(Role.Supervisor, "review-admin");
        var target = await host.CreateUserAsync(Role.Tier1, "review-target");
        var (api, _) = host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = admin.Username, Password = ConsoleTestHost.KnownPassword }, default);
        int before = await host.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.Event == AuditEvent.UpdateUser && a.Result == AuditResult.Denied));
        await Assert.ThrowsAsync<ApiException>(() => api.UpdateUserAsync(target.Id,
            new UpdateUserRequest { SupportAccountsOnly = guarded, Role = (Role)999 }, default));
        var state = await host.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.Id == target.Id));
        Assert.Equal(Role.Tier1, state.Role);
        Assert.True(state.IsActive);
        int after = await host.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.Event == AuditEvent.UpdateUser && a.Result == AuditResult.Denied));
        Assert.Equal(before + 1, after);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Promoted_target_refusal_clears_stale_selection_and_has_no_success_audit(bool disable)
    {
        using var host = new ConsoleTestHost();
        var admin = await host.CreateUserAsync(Role.Supervisor, "review-admin");
        var target = await host.CreateUserAsync(Role.Tier1, "review-target");
        var (api, session) = host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = admin.Username, Password = ConsoleTestHost.KnownPassword }, default);
        var vm = new StaffViewModel(api, session, new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync(); vm.SelectedUser = vm.Users.Single(u => u.Id == target.Id);
        await api.UpdateUserAsync(target.Id, new UpdateUserRequest { Role = Role.Supervisor }, default);
        int before = await host.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.Event == AuditEvent.UpdateUser && a.Result == AuditResult.Success));
        if (disable) { vm.DisableConfirmed = true; await vm.DisableCommand.ExecuteAsync(null); }
        else { vm.SelectedTier = Role.Tier2; await vm.SaveTierCommand.ExecuteAsync(null); }
        Assert.True(vm.HasError); Assert.Null(vm.SelectedUser); Assert.Empty(vm.Users);
        Assert.False(vm.DisableConfirmed); Assert.False(vm.DisableCommand.CanExecute(null)); Assert.False(vm.SaveTierCommand.CanExecute(null));
        Assert.Equal(before, await host.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.Event == AuditEvent.UpdateUser && a.Result == AuditResult.Success)));
        Assert.Equal(1, await host.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.Event == AuditEvent.UpdateUser && a.Result == AuditResult.Denied)));
        var state = await host.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.Id == target.Id));
        Assert.Equal(Role.Supervisor, state.Role); Assert.True(state.IsActive);
    }
}
