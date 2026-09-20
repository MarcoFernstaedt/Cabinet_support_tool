using System.Net;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using Microsoft.EntityFrameworkCore;
using Xunit.Abstractions;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class IndependentStaffDeltaTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Committed_body_loss_clears_stale_decision_and_signout_discards_late_state(bool disable, bool signout)
    {
        using var host = new ConsoleTestHost();
        var admin=await host.CreateUserAsync(Role.Supervisor,"review-admin");
        var target=await host.CreateUserAsync(Role.Tier1,"review-target");
        var session=new SessionStore();
        var gate=new AfterCommitGate { InnerHandler=host.Server.CreateHandler(), DropBody=true };
        using var http=new HttpClient(new BearerTokenHandler(session){InnerHandler=gate}) {BaseAddress=new Uri("http://localhost")};
        var api=new ApiClient(http,session);
        await api.LoginAsync(new LoginRequest{Username=admin.Username,Password=ConsoleTestHost.KnownPassword},default);
        var vm=new StaffViewModel(api,session,new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync();
        vm.Username="new-synthetic-support"; vm.DisplayName="Synthetic support";
        if(disable){vm.SelectedUser=vm.Users.Single(u=>u.Id==target.Id);vm.DisableConfirmed=true;}
        var pending=disable ? vm.DisableCommand.ExecuteAsync(null) : vm.CreateCommand.ExecuteAsync("Synthetic!OnlyPassword42");
        await gate.Committed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        if(signout){session.SignOut();vm.Reset();}
        gate.Release.TrySetResult(); await pending;
        if(disable) Assert.False(await host.WithDbAsync(db=>db.Users.Where(u=>u.Id==target.Id).Select(u=>u.IsActive).SingleAsync()));
        else Assert.Equal(1,await host.WithDbAsync(db=>db.Users.CountAsync(u=>u.Username=="new-synthetic-support")));
        Assert.Equal(1,gate.Writes);
        if(signout){Assert.Empty(vm.Users);Assert.Empty(vm.Outcome);Assert.Null(vm.SelectedUser);Assert.False(vm.HasError);}
        else {
            Assert.True(vm.HasError);Assert.Contains("not confirmed",vm.Outcome);
            if(disable){Assert.Empty(vm.Users);Assert.Null(vm.SelectedUser);Assert.False(vm.DisableConfirmed);Assert.False(vm.DisableCommand.CanExecute(null));Assert.False(vm.SaveTierCommand.CanExecute(null));}
        }
        output.WriteLine($"Committed {(disable?"disable":"create")}; body lost; signout={signout}; durable effect once; stale decision cleared.");
    }

    [Fact]
    public async Task Changing_selected_row_during_pending_disable_never_disables_replacement()
    {
        using var host=new ConsoleTestHost();var admin=await host.CreateUserAsync(Role.Supervisor,"review-admin");
        var first=await host.CreateUserAsync(Role.Tier1,"first");var second=await host.CreateUserAsync(Role.Tier2,"second");
        var session=new SessionStore();var gate=new AfterCommitGate{InnerHandler=host.Server.CreateHandler()};
        using var http=new HttpClient(new BearerTokenHandler(session){InnerHandler=gate}){BaseAddress=new Uri("http://localhost")};var api=new ApiClient(http,session);
        await api.LoginAsync(new LoginRequest{Username=admin.Username,Password=ConsoleTestHost.KnownPassword},default);
        var vm=new StaffViewModel(api,session,new RecordingLiveRegionAnnouncer());await vm.LoadAsync();vm.SelectedUser=vm.Users.Single(u=>u.Id==first.Id);vm.DisableConfirmed=true;
        var pending=vm.DisableCommand.ExecuteAsync(null);await gate.Committed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        vm.SelectedUser=vm.Users.Single(u=>u.Id==second.Id);Assert.False(vm.DisableConfirmed);Assert.False(vm.DisableCommand.CanExecute(null));
        gate.Release.TrySetResult();await pending;
        Assert.False(await host.WithDbAsync(db=>db.Users.Where(u=>u.Id==first.Id).Select(u=>u.IsActive).SingleAsync()));
        Assert.True(await host.WithDbAsync(db=>db.Users.Where(u=>u.Id==second.Id).Select(u=>u.IsActive).SingleAsync()));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stale_support_row_must_not_modify_account_promoted_to_supervisor(bool disable)
    {
        using var host=new ConsoleTestHost();var admin=await host.CreateUserAsync(Role.Supervisor,"review-admin");var target=await host.CreateUserAsync(Role.Tier1,"review-target");
        var (api,session)=host.CreateConsole();await api.LoginAsync(new LoginRequest{Username=admin.Username,Password=ConsoleTestHost.KnownPassword},default);
        var vm=new StaffViewModel(api,session,new RecordingLiveRegionAnnouncer());await vm.LoadAsync();vm.SelectedUser=vm.Users.Single(u=>u.Id==target.Id);
        // A competing authorized administrator changes current server facts after the UI loaded them.
        var (competing,_)=host.CreateConsole();await competing.LoginAsync(new LoginRequest{Username=admin.Username,Password=ConsoleTestHost.KnownPassword},default);
        await competing.UpdateUserAsync(target.Id,new UpdateUserRequest{Role=Role.Supervisor},default);
        if(disable){vm.DisableConfirmed=true;await vm.DisableCommand.ExecuteAsync(null);}else{vm.SelectedTier=Role.Tier2;await vm.SaveTierCommand.ExecuteAsync(null);}
        var state=await host.WithDbAsync(db=>db.Users.AsNoTracking().SingleAsync(u=>u.Id==target.Id));
        output.WriteLine($"Previously selected support account now: role={state.Role}; active={state.IsActive}; requested={(disable?"disable":"tier change")}");
        Assert.Equal(Role.Supervisor,state.Role);Assert.True(state.IsActive);
    }

    [Fact]
    public async Task Both_support_tiers_have_equal_observation_catalog_and_cannot_administer_accounts()
    {
        using var host=new ConsoleTestHost();
        var cabinet=await host.CreateCabinetAsync("Synthetic",lastCheckInUtc:DateTimeOffset.UtcNow);
        string? priorCatalog=null;
        foreach(var role in new[]{Role.Tier1,Role.Tier2})
        {
            var user=await host.CreateUserAsync(role,"review-"+role);
            var (api,session)=host.CreateConsole();
            await api.LoginAsync(new LoginRequest{Username=user.Username,Password=ConsoleTestHost.KnownPassword},default);
            var catalog=System.Text.Json.JsonSerializer.Serialize(await api.GetActionCatalogAsync(default));
            if(priorCatalog is not null)Assert.Equal(priorCatalog,catalog); priorCatalog=catalog;
            var created=await api.CreateActionAsync(new CabinetPlatform.Contracts.Actions.CreateActionRequest{CabinetId=cabinet.Id,Action=CabinetPlatform.Contracts.Actions.ActionName.GetProcessList,Reason="Synthetic authorized observation"},default);
            Assert.Equal(cabinet.Id,created.CabinetId);
            var vm=new StaffViewModel(api,session,new RecordingLiveRegionAnnouncer());
            Assert.False(vm.IsSupervisor);Assert.False(vm.RefreshCommand.CanExecute(null));
            foreach(var operation in new Func<Task>[] {
                async()=>{await api.GetUsersAsync(new(),default);},
                async()=>{await api.CreateUserAsync(new CreateUserRequest{Username="forbidden",DisplayName="Forbidden",Role=Role.Supervisor,InitialPassword="Synthetic!OnlyPassword42"},default);},
                async()=>{await api.UpdateUserAsync(user.Id,new UpdateUserRequest{Role=Role.Supervisor},default);}})
            {
                var denied=await Assert.ThrowsAsync<ApiException>(operation);Assert.Equal(ApiFailure.Forbidden,denied.Failure);
            }
        }
    }

    [Fact]
    public async Task Staff_supervisor_binding_notifies_when_prelogin_view_becomes_authorized()
    {
        using var host=new ConsoleTestHost();var admin=await host.CreateUserAsync(Role.Supervisor,"review-admin");
        var (api,session)=host.CreateConsole();var vm=new StaffViewModel(api,session,new RecordingLiveRegionAnnouncer());
        // Match App startup: singleton viewmodel/DataContext exists before the login dialog.
        bool boundIsSupervisor=vm.IsSupervisor;int notifications=0;
        vm.PropertyChanged+=(_,e)=>{if(string.IsNullOrEmpty(e.PropertyName)||e.PropertyName==nameof(StaffViewModel.IsSupervisor)){boundIsSupervisor=vm.IsSupervisor;notifications++;}};
        await api.LoginAsync(new LoginRequest{Username=admin.Username,Password=ConsoleTestHost.KnownPassword},default);
        await vm.LoadAsync();
        Assert.True(vm.IsSupervisor);
        output.WriteLine($"Supervisor getter={vm.IsSupervisor}; property-bound value={boundIsSupervisor}; relevant notifications={notifications}");
        Assert.True(boundIsSupervisor,"StaffView's IsEnabled binding needs an IsSupervisor property notification after sign-in.");
    }

    private sealed class AfterCommitGate:DelegatingHandler
    {
        public bool DropBody;public int Writes;
        public TaskCompletionSource Committed {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            var response=await base.SendAsync(request,ct);
            if((request.Method==HttpMethod.Post&&request.RequestUri!.AbsolutePath=="/api/users")||(request.Method==HttpMethod.Patch&&request.RequestUri!.AbsolutePath.StartsWith("/api/users/",StringComparison.Ordinal)))
            {response.EnsureSuccessStatusCode();Writes++;Committed.TrySetResult();await Release.Task;if(DropBody){response.Content.Dispose();response.Content=new LostBody();}}
            return response;
        }
    }
    private sealed class LostBody:HttpContent
    {
        public LostBody(){Headers.ContentType=new("application/json");}
        protected override bool TryComputeLength(out long length){length=0;return false;}
        protected override Task SerializeToStreamAsync(Stream stream,TransportContext? context)=>Task.FromException(new IOException("Synthetic interrupted response body"));
    }
}
