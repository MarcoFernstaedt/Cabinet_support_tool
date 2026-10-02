using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

public class IndependentRenewalReviewTests
{
    public static string Hash(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)));
    public sealed class Clock : TimeProvider { public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => Now; }
    public sealed class StoreFixture : IDisposable
    {
        public string Root = Path.Combine(Path.GetTempPath(), "independent-renewal-" + Guid.NewGuid().ToString("N"));
        public string Key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        public string Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        public Clock Clock = new();
        public OfficeEnrollmentOptions Options;
        public StoreFixture() {
            Directory.CreateDirectory(Root);
            Options = new() { Enabled = true, StateFile = Path.Combine(Root,"grants.json"), Tokens = [new() {
                TokenHash=Hash(Token), IssuedUtc=Clock.Now, ExpiresUtc=Clock.Now.AddMinutes(20), DeviceExpiresUtc=Clock.Now.AddDays(1) }] };
            File.WriteAllText(Options.StateFile,"[]");
        }
        public OfficeEnrollmentStore Open() => new(Microsoft.Extensions.Options.Options.Create(Options),Clock);
        public DefaultHttpContext Context() { var c = new DefaultHttpContext(); c.Request.Headers["X-Mashura-Machine-Id"]="device"; c.Request.Headers["X-Mashura-Agent-Key"]=Key; return c; }
        public bool Auth(OfficeEnrollmentStore s) => s.Authenticate(Context(),new()).IsAuthenticated;
        public void Dispose() => Directory.Delete(Root,true);
    }

    [Fact]
    public void Exact_uuid_global_collisions_cap_expiry_and_restart() {
        using var f=new StoreFixture();
        var token2=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        f.Options.Tokens.Add(f.Options.Tokens[0] with {TokenHash=Hash(token2)});
        var id=Guid.NewGuid(); DateTimeOffset? expiry;
        using(var s=f.Open()) {
            Assert.True(s.Redeem(f.Token,"device",f.Key)); Assert.True(s.Redeem(token2,"other",f.Key));
            f.Clock.Now=f.Clock.Now.AddDays(2); expiry=s.Renew("device",id,"actor","reason"); Assert.Equal(f.Clock.Now.AddDays(1),expiry);
            Assert.Null(s.Renew("other",id,"actor","reason")); Assert.Null(s.Renew("device",id,"different","reason")); Assert.Null(s.Renew("device",id,"actor","changed"));
            for(int i=1;i<30;i++) Assert.NotNull(s.Renew("device",Guid.NewGuid(),"actor","reason"));
            Assert.Null(s.Renew("device",Guid.NewGuid(),"actor","reason"));
        }
        using(var s=f.Open()) {
            Assert.Equal(expiry,s.Renew("device",id,"actor","reason"));
            f.Clock.Now=expiry!.Value.AddTicks(-1); Assert.True(f.Auth(s)); f.Clock.Now=expiry.Value; Assert.False(f.Auth(s));
        }
    }
    [Fact]
    public void Backward_clock_before_renewal_must_not_authenticate_future_grant() {
        using var f=new StoreFixture(); using var s=f.Open(); Assert.True(s.Redeem(f.Token,"device",f.Key));
        var issued=f.Clock.Now; f.Clock.Now=issued.AddDays(2); Assert.NotNull(s.Renew("device",Guid.NewGuid(),"actor","reason"));
        f.Clock.Now=issued.AddDays(1).AddHours(1);
        Assert.False(f.Auth(s));
    }
    [Fact]
    public void Rollback_reader_must_not_resurrect_tombstoned_unexpired_key() {
        using var f=new StoreFixture(); using(var s=f.Open()) Assert.True(s.Redeem(f.Token,"device",f.Key));
        var token=f.Options.Tokens.Single(); f.Options.Tokens.Clear(); using(var s=f.Open()) Assert.False(f.Auth(s));
        f.Options.Tokens.Add(token); using(var s=f.Open()) Assert.False(f.Auth(s));
        var oldOptions=new BaselineOfficeEnrollmentOptions {Enabled=true,StateFile=f.Options.StateFile,Tokens=[new() {
            TokenHash=token.TokenHash,IssuedUtc=token.IssuedUtc,ExpiresUtc=token.ExpiresUtc,DeviceExpiresUtc=token.DeviceExpiresUtc}]};
        using var old=new BaselineOfficeEnrollmentStore(Microsoft.Extensions.Options.Options.Create(oldOptions),f.Clock);
        Assert.False(old.Authenticate(f.Context(),new()).IsAuthenticated);
    }

    public sealed class CommitFailure : DbTransactionInterceptor {
        public bool Armed, Fired;
        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,TransactionEventData eventData,InterceptionResult result,CancellationToken cancellationToken=default) {
            if(Armed) {Armed=false;Fired=true;throw new IOException("Synthetic SQL commit failure");} return ValueTask.FromResult(result);
        }
    }
    public sealed class SaveFailure : SaveChangesInterceptor {
        public bool Armed,Fired;
        public AuditEvent? PauseEvent;
        public TaskCompletionSource Entered=new(TaskCreationOptions.RunContinuationsAsynchronously), Release=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData data,int result,CancellationToken ct=default) {
            if(Armed) {Armed=false;Fired=true;throw new IOException("Synthetic post-save failure");}
            if(PauseEvent is {} evt && data.Context!.ChangeTracker.Entries<AuditEntry>().Any(e=>e.Entity.Event==evt)) {
                PauseEvent=null;Entered.TrySetResult();await Release.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
            return result;
        }
    }
    public sealed class HttpFixture : IDisposable {
        public StoreFixture Store=new();
        public SupportApiFactory Base=new();
        public WebApplicationFactory<Program> Host;
        public HttpClient Supervisor=null!,Agent=null!;
        public Guid CabinetId,UserId;
        public CommitFailure Commit=new(); public SaveFailure Save=new();
        public string Path => $"/api/office/enroll/renew/{CabinetId}";
        public HttpFixture() {
            using(var s=Store.Open()) Assert.True(s.Redeem(Store.Token,"device",Store.Key));
            Store.Clock.Now=Store.Clock.Now.AddDays(2);
            var t=Store.Options.Tokens.Single();
            Host=Base.WithWebHostBuilder(b=> {
                b.ConfigureAppConfiguration((_,c)=>c.AddInMemoryCollection(new Dictionary<string,string?> {
                    ["OfficeEnrollment:Enabled"]="true",["OfficeEnrollment:StateFile"]=Store.Options.StateFile,
                    ["OfficeEnrollment:Tokens:0:TokenHash"]=t.TokenHash,["OfficeEnrollment:Tokens:0:IssuedUtc"]=t.IssuedUtc.ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"]=t.ExpiresUtc.ToString("O"),["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"]=t.DeviceExpiresUtc.ToString("O") }));
                b.ConfigureTestServices(s=> {
                    s.RemoveAll<TimeProvider>(); s.AddSingleton<TimeProvider>(Store.Clock);
                    s.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
                    s.AddDbContext<SqliteSupportDbContext>((sp,o)=>o.UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString).AddInterceptors(Commit,Save));
                });
            });
        }
        public async Task Init() {
            Supervisor=Host.CreateClient(); Agent=Host.CreateClient();
            using var scope=Host.Services.CreateScope(); var db=scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var user=await db.Users.SingleAsync(u=>u.Role==Role.Supervisor); user.MustChangePassword=false; UserId=user.Id;
            var cabinet=new Cabinet {MachineId="device",Hostname="synthetic",Site=new Site {Name="lab",Client=new Client {Name="lab"}},ApprovedByUserId=user.Id,ApprovedUtc=Store.Clock.Now};
            db.Cabinets.Add(cabinet);await db.SaveChangesAsync();CabinetId=cabinet.Id;
            Supervisor.DefaultRequestHeaders.Authorization=new("Bearer",scope.ServiceProvider.GetRequiredService<IJwtTokenService>().Issue(user).AccessToken);
            Agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id","device");Agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key",Store.Key);
        }
        public async Task<int> Audits() {using var scope=Host.Services.CreateScope(); return await scope.ServiceProvider.GetRequiredService<SupportDbContext>().AuditEntries.CountAsync(a=>a.Event==AuditEvent.RenewOfficeDevice);}
        public List<OfficeEnrollmentStore.Grant> Grants()=>JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(File.ReadAllText(Store.Options.StateFile))!;
        public void Dispose(){Supervisor?.Dispose();Agent?.Dispose();Host.Dispose();Base.Dispose();Store.Dispose();}
    }
    [Theory]
    [InlineData("role")][InlineData("disabled")][InlineData("stamp")][InlineData("password")]
    public async Task Current_operator_authority_is_checked(string kind) {
        using var f=new HttpFixture();await f.Init();
        using(var scope=f.Host.Services.CreateScope()) {var db=scope.ServiceProvider.GetRequiredService<SupportDbContext>();var u=await db.Users.SingleAsync(u=>u.Id==f.UserId);
            if(kind=="role")u.Role=Role.Tier2;if(kind=="disabled")u.IsActive=false;if(kind=="stamp")u.SecurityStamp=Guid.NewGuid();if(kind=="password")u.MustChangePassword=true;await db.SaveChangesAsync();}
        Assert.Equal(HttpStatusCode.Unauthorized,(await f.Supervisor.PostAsJsonAsync(f.Path,new {RequestId=Guid.NewGuid(),Reason="test"})).StatusCode);
        Assert.Empty(f.Grants()[0].Renewals);Assert.Equal(0,await f.Audits());
    }
    [Theory]
    [InlineData("save")][InlineData("journal")][InlineData("commit")]
    public async Task Cross_store_failures_have_explicit_durable_outcomes_and_exact_retry(string point) {
        using var f=new HttpFixture();await f.Init(); var req=new {RequestId=Guid.NewGuid(),Reason="test"};
        var before=File.ReadAllText(f.Store.Options.StateFile);
        if(point=="save")f.Save.Armed=true;if(point=="commit")f.Commit.Armed=true;
        if(point=="journal")File.Move(f.Store.Options.StateFile,f.Store.Options.StateFile+".held");
        Assert.Equal(HttpStatusCode.InternalServerError,(await f.Supervisor.PostAsJsonAsync(f.Path,req)).StatusCode);
        Assert.Equal(0,await f.Audits());
        if(point=="journal")File.Move(f.Store.Options.StateFile+".held",f.Store.Options.StateFile);
        if(point=="commit") {Assert.True(f.Commit.Fired);Assert.Single(f.Grants()[0].Renewals);Assert.Equal(HttpStatusCode.OK,(await f.Agent.GetAsync("/api/agent/actions")).StatusCode);}
        else {if(point=="save")Assert.True(f.Save.Fired);Assert.Equal(before,File.ReadAllText(f.Store.Options.StateFile));Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.GetAsync("/api/agent/actions")).StatusCode);}
        Assert.Equal(HttpStatusCode.OK,(await f.Supervisor.PostAsJsonAsync(f.Path,req)).StatusCode);Assert.Single(f.Grants()[0].Renewals);Assert.Equal(1,await f.Audits());
    }
    public sealed class LoseResponse : DelegatingHandler {
        public bool Lost;
        public LoseResponse(HttpMessageHandler inner) : base(inner) {}
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct) {
            var response=await base.SendAsync(request,ct);
            if(!Lost && response.IsSuccessStatusCode) {Lost=true;response.Dispose();throw new HttpRequestException("Synthetic response lost after real commit");}
            return response;
        }
    }
    [Fact]
    public async Task Actual_handler_response_loss_reconciles_without_new_expiry() {
        using var f=new HttpFixture();await f.Init();var req=new {RequestId=Guid.NewGuid(),Reason="test"};
        using var loss=new LoseResponse(f.Host.Server.CreateHandler());using var client=new HttpClient(loss) {BaseAddress=new Uri("http://localhost")};
        client.DefaultRequestHeaders.Authorization=f.Supervisor.DefaultRequestHeaders.Authorization;
        await Assert.ThrowsAsync<HttpRequestException>(()=>client.PostAsJsonAsync(f.Path,req));Assert.True(loss.Lost);
        var first=f.Grants()[0].Renewals.Single();Assert.Equal(1,await f.Audits());
        Assert.Equal(HttpStatusCode.OK,(await client.PostAsJsonAsync(f.Path,req)).StatusCode);Assert.Equal(first,f.Grants()[0].Renewals.Single());Assert.Equal(2,await f.Audits());
    }
    [Theory]
    [InlineData("wrong-key")][InlineData("wrong-machine")][InlineData("shared-key")][InlineData("expired")]
    public async Task All_agent_routes_reject_bad_binding_or_expired_key(string mode) {
        using var f=new HttpFixture();await f.Init();
        if(mode!="expired") Assert.Equal(HttpStatusCode.OK,(await f.Supervisor.PostAsJsonAsync(f.Path,new {RequestId=Guid.NewGuid(),Reason="test"})).StatusCode);
        if(mode=="wrong-machine") {f.Agent.DefaultRequestHeaders.Remove("X-Mashura-Machine-Id");f.Agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id","other");}
        if(mode is "wrong-key" or "shared-key") {f.Agent.DefaultRequestHeaders.Remove("X-Mashura-Agent-Key");f.Agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key",mode=="shared-key"?SupportApiFactory.AgentSharedSecret:Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));}
        foreach(var p in new[]{"/api/agent/register","/api/agent/checkin","/api/agent/checkin/full","/api/agent/actions/result","/api/agent/connectivity/summaries"})
            Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.PostAsJsonAsync(p,new {})).StatusCode);
        foreach(var p in new[]{"/api/agent/actions","/api/agent/connectivity/plan"}) Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.GetAsync(p)).StatusCode);
    }
    [Theory]
    [InlineData("missing-grant")][InlineData("revoked")][InlineData("missing-row")]
    public async Task Missing_or_revoked_identity_cannot_renew(string mode) {
        using var f=new HttpFixture();
        if(mode=="missing-grant") File.WriteAllText(f.Store.Options.StateFile,"[]");
        if(mode=="revoked") {var g=f.Grants()[0] with {Revoked=true};File.WriteAllText(f.Store.Options.StateFile,JsonSerializer.Serialize(new[]{g}));}
        await f.Init();
        var path=mode=="missing-row"?$"/api/office/enroll/renew/{Guid.NewGuid()}":f.Path;
        Assert.Equal(HttpStatusCode.Conflict,(await f.Supervisor.PostAsJsonAsync(path,new {RequestId=Guid.NewGuid(),Reason="test"})).StatusCode);Assert.Equal(0,await f.Audits());
    }
    [Fact]
    public async Task Discarded_success_response_reconciles_without_new_expiry() {
        using var f=new HttpFixture();await f.Init();var req=new {RequestId=Guid.NewGuid(),Reason="test"};
        using(var response=await f.Supervisor.PostAsJsonAsync(f.Path,req)) Assert.Equal(HttpStatusCode.OK,response.StatusCode);
        var first=f.Grants()[0].Renewals.Single();
        Assert.Equal(HttpStatusCode.OK,(await f.Supervisor.PostAsJsonAsync(f.Path,req)).StatusCode);
        Assert.Equal(first,f.Grants()[0].Renewals.Single());Assert.Equal(2,await f.Audits());
    }
    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task Renewal_retirement_overlap_both_lock_orders(bool renewalFirst) {
        using var f=new HttpFixture();await f.Init();var req=new {RequestId=Guid.NewGuid(),Reason="test"};
        f.Save.PauseEvent=renewalFirst?AuditEvent.RenewOfficeDevice:AuditEvent.RetireCabinet;
        Task<HttpResponseMessage> Renew()=>f.Supervisor.PostAsJsonAsync(f.Path,req);
        Task<HttpResponseMessage> Retire()=>f.Supervisor.PostAsJsonAsync($"/api/cabinets/{f.CabinetId}/retire",new {Reason="synthetic retirement"});
        var first=Task.Run<HttpResponseMessage>(renewalFirst?Renew:Retire);await f.Save.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var second=Task.Run<HttpResponseMessage>(renewalFirst?Retire:Renew);
        await Task.Delay(200);Assert.False(second.IsCompleted);f.Save.Release.TrySetResult();
        var a=await first.WaitAsync(TimeSpan.FromSeconds(15));var b=await second.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(renewalFirst?HttpStatusCode.OK:HttpStatusCode.NoContent,a.StatusCode);
        Assert.Equal(renewalFirst?HttpStatusCode.NoContent:HttpStatusCode.Conflict,b.StatusCode);
        Assert.Equal(renewalFirst?1:0,f.Grants()[0].Renewals.Count);
        Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.GetAsync("/api/agent/actions")).StatusCode);
    }
    [Fact]
    public async Task Renewed_then_retired_office_key_is_refused_on_every_agent_route() {
        using var f=new HttpFixture();await f.Init();var req=new {RequestId=Guid.NewGuid(),Reason="test"};
        Assert.Equal(HttpStatusCode.OK,(await f.Supervisor.PostAsJsonAsync(f.Path,req)).StatusCode);
        var previousHash=f.Grants()[0].KeyHash;
        Assert.Equal(HttpStatusCode.NoContent,(await f.Supervisor.PostAsJsonAsync($"/api/cabinets/{f.CabinetId}/retire",new {Reason="synthetic retirement"})).StatusCode);
        var tombstone=f.Grants()[0]; Assert.True(tombstone.Revoked && tombstone.KeyDestroyed); Assert.NotEqual(previousHash,tombstone.KeyHash);
        Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.PostAsJsonAsync("/api/agent/register",new RegistrationRequest {MachineId="device",Hostname="lab",OsVersion="test",AgentVersion="test"})).StatusCode);
        foreach(var p in new[]{"/api/agent/checkin","/api/agent/checkin/full"}) Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.PostAsJsonAsync(p,new CheckInPayload {MachineId="device",AgentVersion="test",CollectedAtUtc=DateTimeOffset.UtcNow})).StatusCode);
        foreach(var p in new[]{"/api/agent/actions","/api/agent/connectivity/plan"}) Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.GetAsync(p)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.PostAsJsonAsync("/api/agent/connectivity/summaries",Array.Empty<ConnectivitySummary>())).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,(await f.Agent.PostAsJsonAsync("/api/agent/actions/result",new ActionResultDto {RequestId=Guid.NewGuid(),Status=ActionStatus.Succeeded,StartedAtUtc=DateTimeOffset.UtcNow,CompletedAtUtc=DateTimeOffset.UtcNow})).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict,(await f.Supervisor.PostAsJsonAsync(f.Path,req)).StatusCode);
        Assert.Equal(tombstone.KeyHash,f.Grants()[0].KeyHash); Assert.True(f.Grants()[0].KeyDestroyed);
    }
}
