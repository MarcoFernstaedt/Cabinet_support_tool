using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using Xunit.Abstractions;
namespace CabinetPlatform.Agent.Tests;

// Reviewer-only HTTP reproducer. Approved fixture row is explicit, not a claim to test approval UI.
public sealed class ExtensionConnectivityHttpChronologyTests(ITestOutputHelper output)
{
 [Fact]
 public async Task Unique_device_ingestion_persists_incident_after_its_recovery_in_split_failure_run()
 {
  var root=Path.Combine(Path.GetTempPath(),"extension-chronology-"+Guid.NewGuid().ToString("N"));
  Directory.CreateDirectory(root);
  var state=Path.Combine(root,"grants.json"); await File.WriteAllTextAsync(state,"[]");
  var token=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
  var key=Convert.ToHexString(RandomNumberGenerator.GetBytes(32)); var now=DateTimeOffset.UtcNow;
  try
  {
   using var factory=new ConsoleTestHost();
   using var host=factory.WithWebHostBuilder(b=>b.ConfigureAppConfiguration((_,c)=>c.AddInMemoryCollection(new Dictionary<string,string?> {
    ["OfficeEnrollment:Enabled"]="true",["OfficeEnrollment:StateFile"]=state,
    ["OfficeEnrollment:Tokens:0:TokenHash"]=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))),
    ["OfficeEnrollment:Tokens:0:IssuedUtc"]=now.ToString("O"),["OfficeEnrollment:Tokens:0:ExpiresUtc"]=now.AddMinutes(20).ToString("O"),
    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"]=now.AddDays(1).ToString("O") })));
   using var agent=host.CreateClient();
   using var enrolled=await agent.PostAsJsonAsync("/api/office/enroll",new {Token=token,DeviceKey=key,MachineId="chronology-source"});
   Assert.Equal(HttpStatusCode.NoContent,enrolled.StatusCode);
   agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key",key); agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id","chronology-source");
   Cabinet source,target;
   using(var scope=host.Services.CreateScope())
   {
    var db=scope.ServiceProvider.GetRequiredService<SupportDbContext>();
    var site=new Site {Name="Synthetic chronology site",Client=new Client {Name="Synthetic chronology client"}};
    source=new Cabinet {MachineId="chronology-source",Hostname="Synthetic source",Site=site,IsActive=true,ApprovedUtc=now};
    target=new Cabinet {MachineId="chronology-target",Hostname="Synthetic target",Site=site,IsActive=true,ApprovedUtc=now};
    db.Cabinets.AddRange(source,target);
    var hash=scope.ServiceProvider.GetRequiredService<IPasswordHasher>().Hash(ConsoleTestHost.KnownPassword);
    db.Users.Add(new User {Username="chronology-supervisor",DisplayName="Synthetic supervisor",Role=Role.Supervisor,PasswordHash=hash.Hash,PasswordSalt=hash.Salt,PasswordIterations=hash.Iterations,IsActive=true,MustChangePassword=false,CreatedUtc=now});
    await db.SaveChangesAsync();
   }
   using var support=host.CreateClient();
   using var signedIn=await support.PostAsJsonAsync("/api/auth/login",new LoginRequest {Username="chronology-supervisor",Password=ConsoleTestHost.KnownPassword});
   signedIn.EnsureSuccessStatusCode();
   var login=await signedIn.Content.ReadFromJsonAsync<LoginResponse>(AgentJson.SerializerOptions);
   support.DefaultRequestHeaders.Authorization=new("Bearer",login!.AccessToken);
   using var configured=await support.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets",new {Reason="Synthetic chronology acceptance",Targets=new[]{new {CabinetId=target.Id,Address="192.168.50.20"}}});
   configured.EnsureSuccessStatusCode();
   var plan=(await agent.GetFromJsonAsync<ConnectivityPlan>("/api/agent/connectivity/plan",AgentJson.SerializerOptions))!;
   var first=DateTimeOffset.UtcNow.AddMinutes(-8);
   var prior=new ConnectivitySummary {Id=Guid.NewGuid(),ConfigurationId=plan.ConfigurationId,SourceCabinetId=source.Id,TargetCabinetId=target.Id,
    FirstObservedUtc=first,LastObservedUtc=first.AddMinutes(2),SuccessCount=1,FailureCount=2,LeadingFailures=0,TrailingFailures=2,MaximumFailureRun=2,
    LastSuccessUtc=first,LastFailureUtc=first.AddMinutes(2)};
   using var firstResponse=await agent.PostAsJsonAsync("/api/agent/connectivity/summaries",new[]{prior},AgentJson.SerializerOptions);
   firstResponse.EnsureSuccessStatusCode();
   var next=prior with {Id=Guid.NewGuid(),FirstObservedUtc=first.AddMinutes(3),LastObservedUtc=first.AddMinutes(5),
    LeadingFailures=1,TrailingFailures=1,MaximumFailureRun=1,LastSuccessUtc=first.AddMinutes(4),LastFailureUtc=first.AddMinutes(5)};
   using var nextResponse=await agent.PostAsJsonAsync("/api/agent/connectivity/summaries",new[]{next},AgentJson.SerializerOptions);
   nextResponse.EnsureSuccessStatusCode();
   var status=(await support.GetFromJsonAsync<ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}",AgentJson.SerializerOptions))!;
   var link=Assert.Single(status.Links); Assert.Equal(2,status.RecentEvidence.Count);
   Assert.Equal(prior, Assert.Single(status.RecentEvidence, e => e.Summary.Id == prior.Id).Summary);
   Assert.Equal(next, Assert.Single(status.RecentEvidence, e => e.Summary.Id == next.Id).Summary);
   using var retryResponse=await agent.PostAsJsonAsync("/api/agent/connectivity/summaries",new[]{next},AgentJson.SerializerOptions);
   retryResponse.EnsureSuccessStatusCode();
   var afterRetry=(await support.GetFromJsonAsync<ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}",AgentJson.SerializerOptions))!;
   Assert.Equal(2, afterRetry.RecentEvidence.Count);
   Assert.Equal(link.IncidentObservedUtc, Assert.Single(afterRetry.Links).IncidentObservedUtc);
   using(var scope=host.Services.CreateScope())
   {
    var db=scope.ServiceProvider.GetRequiredService<SupportDbContext>();
    var saved=await db.ConnectivityConfigurations.AsNoTracking().SingleAsync(c=>c.SourceCabinetId==source.Id);
    var persisted=Assert.Single(JsonSerializer.Deserialize<ConnectivityLinkState[]>(saved.StatesJson,AgentJson.SerializerOptions)!);
    Assert.Equal(link.IncidentObservedUtc,persisted.IncidentObservedUtc);
    Assert.Equal(link.RecoveredObservedUtc,persisted.RecoveredObservedUtc);
   }
   output.WriteLine($"enroll={(int)enrolled.StatusCode}; prior={(int)firstResponse.StatusCode}; next={(int)nextResponse.StatusCode}; evidence={status.RecentEvidence.Count}; durableMatches=True; incidentAfterRecovery={link.IncidentObservedUtc>link.RecoveredObservedUtc}; expectedIncident={first.AddMinutes(3):O}; actualIncident={link.IncidentObservedUtc:O}; recovered={link.RecoveredObservedUtc:O}");
   Assert.Equal(first.AddMinutes(3),link.IncidentObservedUtc);
  }
  finally {Directory.Delete(root,true);}
 }
}
