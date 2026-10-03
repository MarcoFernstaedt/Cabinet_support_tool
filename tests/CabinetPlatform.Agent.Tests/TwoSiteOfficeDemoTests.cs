using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Agent.Connectivity;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit.Abstractions;

namespace CabinetPlatform.Agent.Tests;

/// <summary>Five simulated native machines; real enrollment, approval, transport and persistence.</summary>
public sealed partial class TwoSiteOfficeDemoTests(ITestOutputHelper output)
{
    [Fact(Skip = "Historical synthetic peer probes required target configuration; retired")]
    public async Task Five_unique_agents_two_sites_approval_diagnostics_and_buffered_recovery()
    {
        var root = Path.Combine(Path.GetTempPath(), "two-site-simulation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var steps = new List<object>();
        var specs = new[]
        {
            new Device("SIM-Q-SYNC", "Q site", CabinetRole.Sync, "192.168.50.10"),
            new Device("SIM-Q-02", "Q site", CabinetRole.Satellite, "192.168.50.11"),
            new Device("SIM-Q-03", "Q site", CabinetRole.Satellite, "192.168.50.12"),
            new Device("SIM-R-SYNC", "Second site", CabinetRole.Sync, "192.168.60.10"),
            new Device("SIM-R-02", "Second site", CabinetRole.Satellite, "192.168.60.11")
        };
        var providers = new List<ServiceProvider>();
        try
        {
            var state = Path.Combine(root, "consumed-grants.json");
            await File.WriteAllTextAsync(state, "[]");
            var now = DateTimeOffset.UtcNow;
            var config = new Dictionary<string, string?>
            {
                ["OfficeEnrollment:Enabled"] = "true", ["OfficeEnrollment:StateFile"] = state
            };
            for (int i = 0; i < specs.Length; i++)
            {
                var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
                config[$"OfficeEnrollment:Tokens:{i}:TokenHash"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
                config[$"OfficeEnrollment:Tokens:{i}:IssuedUtc"] = now.ToString("O");
                config[$"OfficeEnrollment:Tokens:{i}:ExpiresUtc"] = now.AddMinutes(20).ToString("O");
                config[$"OfficeEnrollment:Tokens:{i}:DeviceExpiresUtc"] = now.AddDays(1).ToString("O");
                var directory = Path.Combine(root, specs[i].Name);
                Directory.CreateDirectory(directory);
                await File.WriteAllTextAsync(Path.Combine(directory, "enrollment.json"), JsonSerializer.Serialize(new { Token = token, ServerBaseUrl = "https://localhost/" }));
            }
            using var factory = new DiagnosticConsoleTestHost();
            using var server = factory.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(config)));
            var deliveryFaults = new Dictionary<string, DropEvidenceAck>();
            ServiceProvider Agent(Device device)
            {
                var services = new ServiceCollection();
                services.AddLogging();
                services.AddCabinetAgent(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Agent:ServerBaseUrl"] = "https://localhost/",
                    ["Agent:OfficeEnrollmentFile"] = Path.Combine(root, device.Name, "enrollment.json")
                }).Build());
                services.AddSingleton<IMachineIdentityProvider>(new Identity(device.Name));
                services.AddHttpClient(AgentHttpClients.Server).ConfigurePrimaryHttpMessageHandler(() =>
                {
                    var handler = new DropEvidenceAck(server.Server.CreateHandler());
                    deliveryFaults[device.Name] = handler;
                    return handler;
                });
                services.AddHttpClient("cabinet-office-enrollment").ConfigurePrimaryHttpMessageHandler(() => server.Server.CreateHandler());
                return services.BuildServiceProvider();
            }
            foreach (var device in specs)
            {
                using var enrolling = Agent(device);
                var pending = await enrolling.GetRequiredService<IServerClient>().RegisterAsync(Registration(device), default);
                Assert.Equal(RegistrationStatus.Pending, pending?.Status);
                Assert.False(File.Exists(Path.Combine(root, device.Name, "enrollment.json")));
                using var http = enrolling.GetRequiredService<IHttpClientFactory>().CreateClient(AgentHttpClients.Server);
                using var denied = await http.GetAsync("/api/agent/connectivity/plan");
                Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            }
            using (var scope = server.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
                var hash = scope.ServiceProvider.GetRequiredService<IPasswordHasher>().Hash(ConsoleTestHost.KnownPassword);
                db.Users.Add(new CabinetPlatform.Server.Domain.User
                {
                    Username = "simulation-supervisor", DisplayName = "Synthetic supervisor", Role = Role.Supervisor,
                    PasswordHash = hash.Hash, PasswordSalt = hash.Salt, PasswordIterations = hash.Iterations,
                    IsActive = true, MustChangePassword = false, CreatedUtc = now
                });
                await db.SaveChangesAsync();
            }
            var session = new SessionStore();
            using var consoleHttp = server.CreateDefaultClient(new BearerTokenHandler(session));
            var api = new ApiClient(consoleHttp, session);
            await api.LoginAsync(new LoginRequest { Username = "simulation-supervisor", Password = ConsoleTestHost.KnownPassword }, default);
            var announcer = new RecordingLiveRegionAnnouncer();
            var queue = new RegistrationsViewModel(api, session, announcer);
            await queue.LoadAsync();
            Assert.Equal(5, queue.Queue.Count);
            steps.Add(new { stage = "Pending queue", count = queue.Queue.Count, unauthorisedProbePlans = "403 for all five" });
            foreach (var device in specs)
            {
                queue.SelectedRegistration = Assert.Single(queue.Queue, r => r.MachineId == device.Name);
                queue.ClientName = "Synthetic internal lab";
                queue.SiteName = device.Site;
                queue.CabinetRole = device.Role;
                queue.IdentityConfirmed = true;
                Assert.True(queue.AcceptCommand.CanExecute(null));
                await queue.AcceptCommand.ExecuteAsync(null);
                Assert.False(queue.HasError, queue.ErrorMessage);
                var agent = Agent(device);
                providers.Add(agent);
                var approved = await agent.GetRequiredService<IServerClient>().RegisterAsync(Registration(device), default);
                Assert.Equal(RegistrationStatus.Approved, approved?.Status);
                device.Id = approved!.CabinetId!.Value;
                var receipt = await agent.GetRequiredService<IServerClient>().CheckInAsync(Payload(device), CheckInTier.Full, default);
                Assert.Equal(CheckInOutcome.Accepted, receipt.Outcome);
            }
            Assert.Empty(queue.Queue);
            Assert.Equal(5, specs.Select(d => d.Id).Distinct().Count());
            Assert.Equal(5, providers.Select(p => p.GetRequiredService<IAgentCredentialProvider>().GetAgentKey()).Distinct().Count());
            foreach (var site in new[] { "Q site", "Second site" })
            {
                var list = await api.GetCabinetsAsync(new CabinetQuery { SiteName = site, PageSize = 50 }, default);
                var expected = specs.Where(d => d.Site == site).Select(d => d.Id).Order().ToArray();
                Assert.Equal(expected, list.Items.Select(d => d.Id).Order());
                Assert.Equal(expected.Length, list.TotalCount);
                var byIdentity = await api.GetCabinetsAsync(new CabinetQuery { SiteId = list.Items[0].SiteId, PageSize = 50 }, default);
                Assert.Equal(expected, byIdentity.Items.Select(d => d.Id).Order());
                Assert.Equal(expected.Length, byIdentity.TotalCount);
                steps.Add(new { stage = "Approved site filter", site, count = list.TotalCount, cabinets = list.Items.Select(c => new { c.Id, c.Hostname, c.Role, c.Health }) });
            }
            for (int i = 0; i < specs.Length; i++)
            {
                var source = specs[i];
                var target = specs.First(d => d.Site == source.Site && d.Id != source.Id);
                using var configured = await consoleHttp.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
                {
                    Reason = "SIMULATION: explicitly registered same-site target", Targets = new[] { new { CabinetId = target.Id, target.Address } }
                });
                configured.EnsureSuccessStatusCode();
                using var http = providers[i].GetRequiredService<IHttpClientFactory>().CreateClient(AgentHttpClients.Server);
                var plan = (await http.GetFromJsonAsync<ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
                Assert.Equal(target.Id, Assert.Single(plan.Targets).CabinetId);
                Assert.Equal("Unknown", Assert.Single((await api.GetConnectivityAsync(source.Id, default)).Links).Condition);
                var otherSite = specs.First(d => d.Site != source.Site);
                using var forbidden = await consoleHttp.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new
                {
                    Reason = "SIMULATION: negative cross-site probe", Targets = new[] { new { CabinetId = otherSite.Id, otherSite.Address } }
                });
                Assert.Equal(HttpStatusCode.NotFound, forbidden.StatusCode);
                var unchanged = (await http.GetFromJsonAsync<ConnectivityPlan>("/api/agent/connectivity/plan", AgentJson.SerializerOptions))!;
                Assert.Equal(plan.ConfigurationId, unchanged.ConfigurationId);
                var start = DateTimeOffset.UtcNow.AddMinutes(-6);
                var outboxPath = Path.Combine(root, source.Name, "outbox");
                var spool = new ConnectivitySpool(outboxPath);
                var sampler = new ConnectivitySampler(source.Id, new ConnectivitySamplerTests.SequenceProbe(
                    ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply,
                    ProbeObservation.Reply, ProbeObservation.Reply, ProbeObservation.Reply), s => spool.Enqueue(s, DateTimeOffset.UtcNow));
                // Synthetic clock accelerates six minutes; target identity/revision remain server-issued.
                sampler.ApplyPlan(plan with { IssuedUtc = start, ExpiresUtc = start.AddMinutes(10) }, start);
                for (int n = 0; n < 3; n++) await sampler.SampleAsync(start.AddMinutes(n), default);
                deliveryFaults[source.Name].DropNext = true;
                await Assert.ThrowsAsync<HttpRequestException>(() => new ConnectivityDelivery(http, spool, sampler).DeliverAsync(DateTimeOffset.UtcNow, default));
                var reopened = new ConnectivitySpool(outboxPath);
                Assert.Single(reopened.Peek(DateTimeOffset.UtcNow));
                var delivery = new ConnectivityDelivery(http, reopened, sampler);
                Assert.True(await delivery.DeliverAsync(DateTimeOffset.UtcNow, default));
                Assert.Empty(reopened.Peek(DateTimeOffset.UtcNow));
                var failure = await api.GetConnectivityAsync(source.Id, default);
                Assert.Single(failure.RecentEvidence);
                Assert.True(Assert.Single(failure.Links).IncidentOpen);
                Assert.Equal("Unreachable", failure.Links[0].Condition);
                for (int n = 3; n < 6; n++) await sampler.SampleAsync(start.AddMinutes(n), default);
                Assert.True(await delivery.DeliverAsync(DateTimeOffset.UtcNow, default));
                var recovery = await api.GetConnectivityAsync(source.Id, default);
                Assert.Equal(2, recovery.RecentEvidence.Count);
                Assert.False(Assert.Single(recovery.Links).IncidentOpen);
                Assert.Equal("Reachable", recovery.Links[0].Condition);
                Assert.True(recovery.Links[0].IncidentObservedUtc <= recovery.Links[0].RecoveredObservedUtc);
                var clock = new DemoClock { Now = DateTimeOffset.UtcNow };
                var tab = new MachineTabViewModel(api, new ActionInvoker(api, ScriptedActionDialog.Accepting("Synthetic two-site diagnostic"), announcer, session), session, announcer, clock);
                await tab.LoadAsync(source.Id);
                Assert.Equal(source.Name, tab.CabinetHostname);
                Assert.Contains("Reachable", Assert.Single(tab.ConnectivityRows));
                Assert.Contains("MST", tab.ConnectivityRows[0]);
                Assert.Contains("threshold observed", tab.ConnectivityRows[0]);
                if (i == 1) await DemonstrateDiagnostics(tab, api, providers[i].GetRequiredService<IServerClient>(), source, steps);
                clock.Now = clock.Now.AddMinutes(10);
                tab.RefreshFreshness();
                Assert.Contains("STALE / UNKNOWN", Assert.Single(tab.ConnectivityRows));
                steps.Add(new { stage = "Directed reachability", cabinet = source.Name, target = target.Name,
                    states = new[] { "Unknown", "Unreachable", "Reachable", "STALE / UNKNOWN" }, evidenceRows = recovery.RecentEvidence.Count,
                    lostCommittedAcknowledgment = "durable outbox reopened and replayed without duplicate", crossSiteTarget = "refused; original plan preserved" });
            }
            var report = new { simulation = true, nativeWindowsAcceptance = "NOT RUN", generatedMst = DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(-7)).ToString("yyyy-MM-dd HH:mm:ss 'MST'"),
                siteCount = 2, cabinetCount = specs.Length, steps, teardown = "in-process server disposed; synthetic state and credentials deleted in finally; no live endpoint contacted" };
            var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
            output.WriteLine(json);
            var destination = Environment.GetEnvironmentVariable("CABINET_TWO_SITE_REPORT");
            if (!string.IsNullOrEmpty(destination))
            {
                await using var file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                await using var writer = new StreamWriter(file);
                await writer.WriteAsync(json);
            }
        }
        finally
        {
            foreach (var provider in providers) await provider.DisposeAsync();
            Directory.Delete(root, true);
            Assert.False(Directory.Exists(root));
        }
    }

    private sealed class Device(string name, string site, CabinetRole role, string address)
    {
        public string Name { get; } = name;
        public string Site { get; } = site;
        public CabinetRole Role { get; } = role;
        public string Address { get; } = address;
        public Guid Id { get; set; }
    }
    private sealed class Identity(string machine) : IMachineIdentityProvider { public string GetMachineId() => machine; }
    private sealed class DemoClock : TimeProvider { public DateTimeOffset Now { get; set; } public override DateTimeOffset GetUtcNow() => Now; }
    private static RegistrationRequest Registration(Device d) => new() { MachineId = d.Name, Hostname = d.Name, OsVersion = "SIMULATED Windows inputs, not native Windows", AgentVersion = "two-site-simulation" };
    private static CheckInPayload Payload(Device d) => new()
    {
        MachineId = d.Name, CabinetId = d.Id, AgentVersion = "two-site-simulation", CollectedAtUtc = DateTimeOffset.UtcNow.AddMinutes(-20),
        System = new SystemInfo { Hostname = d.Name, TimeZoneId = "US Mountain Standard Time", AnyUserLoggedOn = null },
        Performance = new PerformanceInfo { CpuTotalPercent = null, RamUsedPercent = 92 },
        Disks = new[] { new DiskInfo { DriveLetter = "C:", FreePercent = 28, BitLockerStatus = BitLockerStatus.Unknown, HealthStatus = DiskHealthStatus.Unknown, Smart = null } },
        Network = new NetworkInfo { Adapters = new[] { new NetworkAdapterInfo { Name = "Synthetic Ethernet", Status = NetworkAdapterStatus.Up, IpAddresses = new[] { d.Address }, DhcpEnabled = true } }, ServerReachable = null },
        SectionErrors = new Dictionary<string, string> { ["CPU"] = "Synthetic unavailable measurement", ["SMART"] = "Synthetic controller exposes no SMART" }
    };
    private sealed class DropEvidenceAck(HttpMessageHandler inner) : DelegatingHandler(inner)
    {
        public bool DropNext { get; set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var response = await base.SendAsync(request, ct);
            if (DropNext && request.RequestUri!.AbsolutePath.EndsWith("/connectivity/summaries", StringComparison.Ordinal))
            {
                DropNext = false;
                response.EnsureSuccessStatusCode();
                response.Dispose();
                throw new HttpRequestException("SIMULATION: acknowledgment lost after server commit");
            }
            return response;
        }
    }
}
