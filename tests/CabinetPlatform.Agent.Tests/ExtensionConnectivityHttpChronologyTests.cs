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
 public async Task Enrolled_device_cannot_ingest_but_seeded_split_failure_chronology_remains_readable()
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
   var revision=Guid.NewGuid();
   var first=DateTimeOffset.UtcNow.AddMinutes(-8);
   var prior=new ConnectivitySummary {Id=Guid.NewGuid(),ConfigurationId=revision,SourceCabinetId=source.Id,TargetCabinetId=target.Id,
    FirstObservedUtc=first,LastObservedUtc=first.AddMinutes(2),SuccessCount=1,FailureCount=2,LeadingFailures=0,TrailingFailures=2,MaximumFailureRun=2,
    LastSuccessUtc=first,LastFailureUtc=first.AddMinutes(2)};
   var next=prior with {Id=Guid.NewGuid(),FirstObservedUtc=first.AddMinutes(3),LastObservedUtc=first.AddMinutes(5),
    LeadingFailures=1,TrailingFailures=1,MaximumFailureRun=1,LastSuccessUtc=first.AddMinutes(4),LastFailureUtc=first.AddMinutes(5)};
   var historical=new ConnectivityLinkState {TargetCabinetId=target.Id,Condition="Unreachable",ObservedUtc=next.LastObservedUtc,
    IncidentOpen=true,IncidentObservedUtc=first.AddMinutes(3),RecoveredObservedUtc=first.AddMinutes(2)};
   using(var scope=host.Services.CreateScope())
   {
    var db=scope.ServiceProvider.GetRequiredService<SupportDbContext>();
    db.ConnectivityConfigurations.Add(new ConnectivityConfiguration {SourceCabinetId=source.Id,SiteId=source.SiteId,
     ConfigurationId=revision,TargetsJson=JsonSerializer.Serialize(new[]{new ConnectivityTarget {CabinetId=target.Id,Address="192.168.50.20"}},AgentJson.SerializerOptions),
     StatesJson=JsonSerializer.Serialize(new[]{historical},AgentJson.SerializerOptions),UpdatedUtc=first});
    foreach(var summary in new[]{prior,next}) db.ConnectivityEvidence.Add(new ConnectivityEvidence {Id=summary.Id,
     SourceCabinetId=source.Id,TargetCabinetId=target.Id,ConfigurationId=revision,FirstObservedUtc=summary.FirstObservedUtc,
     ObservedUtc=summary.LastObservedUtc,ReceivedUtc=summary.LastObservedUtc.AddMinutes(1),SummaryJson=JsonSerializer.Serialize(summary,AgentJson.SerializerOptions)});
    await db.SaveChangesAsync();
   }
   var plan=(await agent.GetFromJsonAsync<ConnectivityPlan>("/api/agent/connectivity/plan",AgentJson.SerializerOptions))!;
   Assert.Empty(plan.Targets);
   using var refused=await agent.PostAsJsonAsync("/api/agent/connectivity/summaries",new[]{next},AgentJson.SerializerOptions);
   Assert.Equal(HttpStatusCode.Gone,refused.StatusCode);
   var status=(await support.GetFromJsonAsync<ConnectivityStatusDto>($"/api/connectivity/cabinets/{source.Id}",AgentJson.SerializerOptions))!;
   var link=Assert.Single(status.Links); Assert.Equal(2,status.RecentEvidence.Count);
   Assert.Equal(prior, Assert.Single(status.RecentEvidence, e => e.Summary.Id == prior.Id).Summary);
   Assert.Equal(next, Assert.Single(status.RecentEvidence, e => e.Summary.Id == next.Id).Summary);
   Assert.Equal(first.AddMinutes(3),link.IncidentObservedUtc);
   Assert.True(link.IncidentObservedUtc>link.RecoveredObservedUtc);
   using(var scope=host.Services.CreateScope())
   {
    var db=scope.ServiceProvider.GetRequiredService<SupportDbContext>();
    var saved=await db.ConnectivityConfigurations.AsNoTracking().SingleAsync(c=>c.SourceCabinetId==source.Id);
    Assert.Equal(revision,saved.ConfigurationId);
    Assert.Equal(historical,Assert.Single(JsonSerializer.Deserialize<ConnectivityLinkState[]>(saved.StatesJson,AgentJson.SerializerOptions)!));
    Assert.Equal(2,await db.ConnectivityEvidence.CountAsync(e=>e.SourceCabinetId==source.Id));
   }
   output.WriteLine($"enroll={(int)enrolled.StatusCode}; ingestion={(int)refused.StatusCode}; historicalEvidence={status.RecentEvidence.Count}");
  }
  finally {Directory.Delete(root,true);}
 }
}
