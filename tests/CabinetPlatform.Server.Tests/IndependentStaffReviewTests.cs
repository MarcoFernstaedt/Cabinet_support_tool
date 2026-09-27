using System.Net;
using System.Net.Http.Headers;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Configuration;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

public sealed class IndependentStaffReviewTests
{
    const string Password = "Str0ng!TestPassword";
    static async Task<LoginResponse> Login(HttpClient c, string name) {
        var r = await c.PostJsonAsync("/api/auth/login", new LoginRequest { Username=name, Password=Password });
        Assert.Equal(HttpStatusCode.OK,r.StatusCode);
        return (await r.ReadAsync<LoginResponse>())!;
    }
    static void Bearer(HttpClient c, LoginResponse r) => c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",r.AccessToken);

    [Fact]
    public async Task Failed_logins_at_lockout_threshold_must_not_evict_existing_refresh_authority() {
        using var f = new SupportApiFactory();
        var (_, u) = await TestClient.CreateUserClientAsync(f,Role.Tier1,"threshold-user");
        using var c = f.CreateClient(); var session = await Login(c,u.Username); Bearer(c,session);
        var max = f.Services.GetRequiredService<IOptions<LoginSecurityOptions>>().Value.MaxFailedAttempts;
        using var attacker = f.CreateClient();
        for(int i=0;i<max;i++) Assert.Equal(HttpStatusCode.Forbidden,(await attacker.PostJsonAsync("/api/auth/login",new LoginRequest {Username=u.Username,Password="incorrect"})).StatusCode);
        var locked=await f.WithDbAsync(db=>db.Users.AsNoTracking().SingleAsync(x=>x.Id==u.Id));
        Assert.NotNull(locked.LockedUntilUtc);
        Assert.Equal(HttpStatusCode.Forbidden,(await attacker.PostJsonAsync("/api/auth/login",new LoginRequest {Username=u.Username,Password=Password})).StatusCode);
        Assert.Equal(locked.SecurityStamp,await f.WithDbAsync(db=>db.Users.AsNoTracking().Where(x=>x.Id==u.Id).Select(x=>x.SecurityStamp).SingleAsync()));
        Assert.Equal(HttpStatusCode.OK,(await c.GetAsync("/api/auth/me")).StatusCode);
        var rotated=await c.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=session.RefreshToken});
        Assert.Equal(HttpStatusCode.OK,rotated.StatusCode);
        var current=(await rotated.ReadAsync<RefreshResponse>())!;
        var second=await c.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=current.RefreshToken});
        Assert.Equal(HttpStatusCode.OK,second.StatusCode);
        var active=(await second.ReadAsync<RefreshResponse>())!;
        await f.WithDbAsync(db=>db.Users.Where(x=>x.Id==u.Id).ExecuteUpdateAsync(s=>s.SetProperty(x=>x.LockedUntilUtc,(DateTime?)DateTime.UtcNow.AddMinutes(-1))));
        using var next=f.CreateClient(); var replacement=await Login(next,u.Username); Bearer(next,replacement);
        Assert.Equal(HttpStatusCode.Unauthorized,(await c.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,(await c.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=active.RefreshToken})).StatusCode);
        Assert.Equal(HttpStatusCode.OK,(await next.GetAsync("/api/auth/me")).StatusCode);
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task Missing_target_is_refused_and_denial_is_durable(bool guarded) {
        using var f = new SupportApiFactory();
        var (admin, _) = await TestClient.CreateUserClientAsync(f,Role.Supervisor,"missing-admin");
        int before=await f.WithDbAsync(db=>db.AuditEntries.CountAsync(a=>a.Event==AuditEvent.UpdateUser&&a.Result==AuditResult.Denied));
        var r=await admin.PatchJsonAsync($"/api/users/{Guid.NewGuid()}",new UpdateUserRequest {IsActive=true,SupportAccountsOnly=guarded});
        Assert.Equal(guarded?HttpStatusCode.Conflict:HttpStatusCode.NotFound,r.StatusCode);
        Assert.Equal(before+1,await f.WithDbAsync(db=>db.AuditEntries.CountAsync(a=>a.Event==AuditEvent.UpdateUser&&a.Result==AuditResult.Denied)));
    }

    [Theory]
    [InlineData("refresh")] [InlineData("change-password")]
    public async Task Paused_old_HTTP_mutation_cannot_replace_a_new_login(string route) {
        using var f = new SupportApiFactory();
        var (_,u)=await TestClient.CreateUserClientAsync(f,Role.Tier1,"paused-user");
        var connection=await f.WithDbAsync(db=>Task.FromResult(db.Database.GetConnectionString()!));
        var gate=new SaveGate();
        using var h=f.WithWebHostBuilder(b=>b.ConfigureTestServices(s=>{
            s.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            s.AddSingleton(new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).AddInterceptors(gate).Options);
        }));
        using var old=h.CreateClient(); var initial=await Login(old,u.Username); Bearer(old,initial);
        gate.Armed=true;
        Task<HttpResponseMessage> pending = route=="refresh"
            ? old.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=initial.RefreshToken})
            : old.PostJsonAsync("/api/auth/change-password",new ChangePasswordRequest{CurrentPassword=Password,NewPassword="Replacement!Password42"});
        await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using var next=f.CreateClient(); LoginResponse fresh;
        try { fresh=await Login(next,u.Username); } finally { gate.Release.TrySetResult(); }
        var result=await pending.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.NotEqual(HttpStatusCode.OK,result.StatusCode); Assert.NotEqual(HttpStatusCode.NoContent,result.StatusCode);
        Bearer(next,fresh);
        Assert.Equal(HttpStatusCode.OK,(await next.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK,(await next.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=fresh.RefreshToken})).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,(await old.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,(await old.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=initial.RefreshToken})).StatusCode);
    }

    [Theory]
    [InlineData("Alice","ALICE",true)]
    [InlineData("Jöhn","JÖHN",true)]
    [InlineData("Jöhn","Other",false)]
    public async Task Populated_legacy_startup_preflight_preserves_identities(string a,string b,bool collision) {
        using var f=new SupportApiFactory();
        var (_,u)=await TestClient.CreateUserClientAsync(f,Role.Tier1,"legacy-one");
        var (_,v)=await TestClient.CreateUserClientAsync(f,Role.Tier1,"legacy-two");
        await f.WithDbAsync(async db=>{
            await db.Database.ExecuteSqlRawAsync("DROP INDEX IX_Users_Username_CaseInsensitive");
            await db.Database.ExecuteSqlRawAsync("DELETE FROM __EFMigrationsHistory WHERE MigrationId = '20260927010000_CaseInsensitiveUsernames'");
            await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE Users SET Username={a} WHERE Id={u.Id}");
            await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE Users SET Username={b} WHERE Id={v.Id}");
        });
        var before=await f.WithDbAsync(db=>db.Users.AsNoTracking().OrderBy(x=>x.Id).Select(x=>new{x.Id,x.Username,x.PasswordHash,x.SecurityStamp}).ToListAsync());
        var migrations=await f.WithDbAsync(async db=>(await db.Database.GetAppliedMigrationsAsync()).ToArray());
        var connection=await f.WithDbAsync(db=>Task.FromResult(db.Database.GetConnectionString()!));
        using var h=f.WithWebHostBuilder(web=>web.ConfigureTestServices(s=>{
            s.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            s.AddSingleton(new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options);
        }));
        if(collision) {
            var error=Assert.ThrowsAny<Exception>(()=>h.CreateClient());
            Assert.Contains("Case-equivalent staff usernames",error.ToString());
            Assert.Equal(migrations,await f.WithDbAsync(async db=>(await db.Database.GetAppliedMigrationsAsync()).ToArray()));
        } else {
            using var c=h.CreateClient(); var logged=await Login(c,"JÖHN"); Assert.Equal(u.Id,logged.UserId);
            Assert.Contains("20260927010000_CaseInsensitiveUsernames",await f.WithDbAsync(db=>db.Database.GetAppliedMigrationsAsync()));
        }
        var after=await f.WithDbAsync(db=>db.Users.AsNoTracking().OrderBy(x=>x.Id).Select(x=>new{x.Id,x.Username,x.PasswordHash,x.SecurityStamp}).ToListAsync());
        Assert.Equal(before.Select(x=>(x.Id,x.Username)),after.Select(x=>(x.Id,x.Username)));
        Assert.All(before,x=>Assert.Equal(x.PasswordHash,after.Single(y=>y.Id==x.Id).PasswordHash));
        if(collision) Assert.Equal(before.Select(x=>x.SecurityStamp),after.Select(x=>x.SecurityStamp));
    }

    [Fact]
    public async Task Invalid_ASCII_bootstrap_configuration_must_not_commit_pending_migration() {
        using var f=new SupportApiFactory(); using var initial=f.CreateClient();
        await f.WithDbAsync(async db=>{
            await db.Users.ExecuteDeleteAsync();
            await db.EventLogViews.Where(v=>v.IsSeeded).ExecuteDeleteAsync();
            await db.Database.ExecuteSqlRawAsync("DROP INDEX IX_Users_Username_CaseInsensitive");
            await db.Database.ExecuteSqlRawAsync("DELETE FROM __EFMigrationsHistory WHERE MigrationId = '20260927010000_CaseInsensitiveUsernames'");
        });
        var before=await f.WithDbAsync(async db=>(await db.Database.GetAppliedMigrationsAsync()).ToArray());
        var tables=await f.WithDbAsync(db=>db.Database.SqlQueryRaw<string>("SELECT name AS Value FROM sqlite_master WHERE type='table' ORDER BY name").ToArrayAsync());
        var schema=await f.WithDbAsync(db=>db.Database.SqlQueryRaw<string>("SELECT type || ':' || name || ':' || coalesce(sql,'') AS Value FROM sqlite_master ORDER BY type, name").ToArrayAsync());
        var users=await f.WithDbAsync(db=>db.Users.AsNoTracking().CountAsync());
        var audits=await f.WithDbAsync(db=>db.AuditEntries.AsNoTracking().CountAsync());
        var views=await f.WithDbAsync(db=>db.EventLogViews.AsNoTracking().CountAsync());
        var connection=await f.WithDbAsync(db=>Task.FromResult(db.Database.GetConnectionString()!));
        using var h=f.WithWebHostBuilder(web=>{
            web.ConfigureAppConfiguration((_,c)=>c.AddInMemoryCollection(new Dictionary<string,string?>{["Seed:SupervisorUsername"]="Jöhn"}));
            web.ConfigureTestServices(s=>{
                s.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
                s.AddSingleton(new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options);
            });
        });
        var error=Assert.ThrowsAny<Exception>(()=>h.CreateClient()); Assert.Contains("must use ASCII",error.ToString());
        Assert.Equal(before,await f.WithDbAsync(async db=>(await db.Database.GetAppliedMigrationsAsync()).ToArray()));
        Assert.Equal(tables,await f.WithDbAsync(db=>db.Database.SqlQueryRaw<string>("SELECT name AS Value FROM sqlite_master WHERE type='table' ORDER BY name").ToArrayAsync()));
        Assert.Equal(schema,await f.WithDbAsync(db=>db.Database.SqlQueryRaw<string>("SELECT type || ':' || name || ':' || coalesce(sql,'') AS Value FROM sqlite_master ORDER BY type, name").ToArrayAsync()));
        Assert.Equal(users,await f.WithDbAsync(db=>db.Users.AsNoTracking().CountAsync()));
        Assert.Equal(audits,await f.WithDbAsync(db=>db.AuditEntries.AsNoTracking().CountAsync()));
        Assert.Equal(views,await f.WithDbAsync(db=>db.EventLogViews.AsNoTracking().CountAsync()));
    }

    [Fact]
    public async Task Populated_legacy_unicode_database_ignores_unused_invalid_bootstrap_name()
    {
        using var f=new SupportApiFactory();
        var (_,u)=await TestClient.CreateUserClientAsync(f,Role.Tier1,"unicode-legacy");
        await f.WithDbAsync(async db=>{
            await db.Database.ExecuteSqlRawAsync("DROP INDEX IX_Users_Username_CaseInsensitive");
            await db.Database.ExecuteSqlRawAsync("DELETE FROM __EFMigrationsHistory WHERE MigrationId = '20260927010000_CaseInsensitiveUsernames'");
            await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE Users SET Username={"Jöhn"} WHERE Id={u.Id}");
        });
        var connection=await f.WithDbAsync(db=>Task.FromResult(db.Database.GetConnectionString()!));
        using var h=f.WithWebHostBuilder(web=>{
            web.ConfigureAppConfiguration((_,c)=>c.AddInMemoryCollection(new Dictionary<string,string?>{["Seed:SupervisorUsername"]="Bad\u00e9"}));
            web.ConfigureTestServices(s=>{
                s.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
                s.AddSingleton(new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options);
            });
        });
        using var client=h.CreateClient();
        Assert.Equal(u.Id,(await Login(client,"JÖHN")).UserId);
        Assert.Contains("20260927010000_CaseInsensitiveUsernames",await f.WithDbAsync(db=>db.Database.GetAppliedMigrationsAsync()));
    }

    [Theory]
    [InlineData("promote")] [InlineData("demote")] [InlineData("reactivate")]
    public async Task Paused_HTTP_refresh_cannot_survive_role_or_disable_reactivate(string change) {
        using var f=new SupportApiFactory();
        var (admin,_)=await TestClient.CreateUserClientAsync(f,Role.Supervisor,"race-administrator");
        var (_,u)=await TestClient.CreateUserClientAsync(f,change=="demote"?Role.Tier2:Role.Tier1,"race-staff");
        var connection=await f.WithDbAsync(db=>Task.FromResult(db.Database.GetConnectionString()!));
        var gate=new SaveGate();
        using var h=f.WithWebHostBuilder(b=>b.ConfigureTestServices(s=>{
            s.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            s.AddSingleton(new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).AddInterceptors(gate).Options);
        }));
        using var old=h.CreateClient(); var initial=await Login(old,u.Username); Bearer(old,initial);
        gate.Armed=true;
        var pending=old.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=initial.RefreshToken});
        await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try {
            var edit=change=="reactivate"?new UpdateUserRequest{IsActive=false,SupportAccountsOnly=true}
                :new UpdateUserRequest{Role=change=="promote"?Role.Tier2:Role.Tier1,SupportAccountsOnly=true};
            Assert.Equal(HttpStatusCode.OK,(await admin.PatchJsonAsync($"/api/users/{u.Id}",edit)).StatusCode);
            if(change=="reactivate") Assert.Equal(HttpStatusCode.OK,(await admin.PatchJsonAsync($"/api/users/{u.Id}",new UpdateUserRequest{IsActive=true,SupportAccountsOnly=true})).StatusCode);
        } finally {gate.Release.TrySetResult();}
        Assert.Equal(HttpStatusCode.Forbidden,(await pending.WaitAsync(TimeSpan.FromSeconds(10))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,(await old.GetAsync("/api/auth/me")).StatusCode);
        using var fresh=f.CreateClient(); var next=await Login(fresh,u.Username); Bearer(fresh,next);
        Assert.Equal(HttpStatusCode.Forbidden,(await old.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=initial.RefreshToken})).StatusCode);
        Assert.Equal(HttpStatusCode.OK,(await fresh.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Deleted_authenticated_user_has_no_access_refresh_or_login() {
        using var f=new SupportApiFactory(); var (_,u)=await TestClient.CreateUserClientAsync(f,Role.Tier1,"deleted-synthetic");
        using var c=f.CreateClient(); var login=await Login(c,u.Username); Bearer(c,login);
        await f.WithDbAsync(db=>db.Users.Where(x=>x.Id==u.Id).ExecuteDeleteAsync());
        Assert.Equal(HttpStatusCode.Unauthorized,(await c.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,(await c.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=login.RefreshToken})).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,(await c.PostJsonAsync("/api/auth/login",new LoginRequest{Username=u.Username,Password=Password})).StatusCode);
    }

    [Fact]
    public async Task Losing_concurrent_login_requires_durable_denial_audit() {
        using var f=new SupportApiFactory(); var (_,u)=await TestClient.CreateUserClientAsync(f,Role.Tier1,"audit-racing-login");
        var connection=await f.WithDbAsync(db=>Task.FromResult(db.Database.GetConnectionString()!));
        var hash=new PausedHasher(f.Services.GetRequiredService<CabinetPlatform.Server.Security.IPasswordHasher>());
        using var h=f.WithWebHostBuilder(b=>b.ConfigureTestServices(s=>{
            s.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            s.AddSingleton(new DbContextOptionsBuilder<SqliteSupportDbContext>().UseSqlite(connection).Options);
            s.RemoveAll<CabinetPlatform.Server.Security.IPasswordHasher>();
            s.AddSingleton<CabinetPlatform.Server.Security.IPasswordHasher>(hash);
        }));
        using var old=h.CreateClient(); hash.Armed=true;
        var pending=Task.Run(()=>old.PostJsonAsync("/api/auth/login",new LoginRequest{Username=u.Username,Password=Password}));
        await hash.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using var winner=f.CreateClient(); LoginResponse fresh;
        try{fresh=await Login(winner,u.Username);}finally{hash.Release.TrySetResult();}
        var winningStamp=await f.WithDbAsync(db=>db.Users.AsNoTracking().Where(x=>x.Id==u.Id).Select(x=>x.SecurityStamp).SingleAsync());
        var winningSuccesses=await f.WithDbAsync(db=>db.AuditEntries.CountAsync(a=>a.Event==AuditEvent.Login&&a.Result==AuditResult.Success&&a.ActorId==u.Id.ToString()));
        Assert.Equal(HttpStatusCode.Forbidden,(await pending.WaitAsync(TimeSpan.FromSeconds(10))).StatusCode);
        Bearer(winner,fresh); Assert.Equal(HttpStatusCode.OK,(await winner.GetAsync("/api/auth/me")).StatusCode);
        var denial=await f.WithDbAsync(db=>db.AuditEntries.AsNoTracking().Where(a=>a.Event==AuditEvent.Login&&a.Result==AuditResult.Denied&&a.ActorId==u.Id.ToString()).SingleAsync());
        Assert.Equal("Account changed during sign-in.",denial.Reason);
        Assert.Equal(winningSuccesses,await f.WithDbAsync(db=>db.AuditEntries.CountAsync(a=>a.Event==AuditEvent.Login&&a.Result==AuditResult.Success&&a.ActorId==u.Id.ToString())));
        Assert.Equal(winningStamp,await f.WithDbAsync(db=>db.Users.AsNoTracking().Where(x=>x.Id==u.Id).Select(x=>x.SecurityStamp).SingleAsync()));
        Assert.Equal(HttpStatusCode.OK,(await winner.PostJsonAsync("/api/auth/refresh",new RefreshRequest{RefreshToken=fresh.RefreshToken})).StatusCode);
    }
    sealed class PausedHasher(CabinetPlatform.Server.Security.IPasswordHasher inner):CabinetPlatform.Server.Security.IPasswordHasher {
        public bool Armed;
        public TaskCompletionSource Entered {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public CabinetPlatform.Server.Security.PasswordHashResult Hash(string p)=>inner.Hash(p);
        public bool NeedsRehash(int i)=>inner.NeedsRehash(i);
        public string? ValidateComplexity(string p)=>inner.ValidateComplexity(p);
        public bool Verify(string p,byte[] h,byte[] s,int i){var valid=inner.Verify(p,h,s,i);if(Armed){Armed=false;Entered.TrySetResult();if(!Release.Task.Wait(TimeSpan.FromSeconds(15)))throw new TimeoutException("review gate");}return valid;}
    }

    sealed class SaveGate:SaveChangesInterceptor {
        public bool Armed;
        public TaskCompletionSource Entered {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData e,InterceptionResult<int> r,CancellationToken ct=default) {
            if(Armed){Armed=false;Entered.TrySetResult();await Release.Task.WaitAsync(TimeSpan.FromSeconds(15),ct);} return r;
        }
    }
}
