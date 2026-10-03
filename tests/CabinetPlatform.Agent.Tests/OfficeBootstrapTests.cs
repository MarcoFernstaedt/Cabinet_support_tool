using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Tests;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Contracts.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Agent.Tests;

public sealed partial class OfficeBootstrapTests
{
    [Theory(Skip = "Historical peer sampling relied on newly configuring retired targets; enrollment covered separately")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Unique_office_enrollment_restart_connectivity_and_firewall_share_authenticated_transport(bool loseFirstResponse)
    {
        var root = Path.Combine(Path.GetTempPath(), "office-agent-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var state = Path.Combine(root, "server.json");
        var provision = Path.Combine(root, "enrollment.json");
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var now = DateTimeOffset.UtcNow;
        await File.WriteAllTextAsync(state, "[]");
        await File.WriteAllTextAsync(provision, JsonSerializer.Serialize(new { Token = token, ServerBaseUrl = "https://localhost/" }));
        try
        {
            using var factory = new ConsoleTestHost();
            using var server = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["OfficeEnrollment:Enabled"] = "true",
                    ["OfficeEnrollment:StateFile"] = state,
                    ["OfficeEnrollment:Tokens:0:TokenHash"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))),
                    ["OfficeEnrollment:Tokens:0:IssuedUtc"] = now.ToString("O"),
                    ["OfficeEnrollment:Tokens:0:ExpiresUtc"] = now.AddMinutes(20).ToString("O"),
                    ["OfficeEnrollment:Tokens:0:DeviceExpiresUtc"] = now.AddDays(1).ToString("O"),
                })));
            var exchanges = 0;
            ServiceProvider Agent()
            {
                var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Agent:ServerBaseUrl"] = "https://localhost/",
                    ["Agent:OfficeEnrollmentFile"] = provision,
                }).Build();
                var services = new ServiceCollection();
                services.AddLogging();
                services.AddCabinetAgent(configuration);
                services.AddSingleton<IMachineIdentityProvider>(new Identity());
                services.AddHttpClient("cabinet-server").ConfigurePrimaryHttpMessageHandler(() => server.Server.CreateHandler());
                services.AddHttpClient("cabinet-office-enrollment").ConfigurePrimaryHttpMessageHandler(() =>
                    new LostResponseHandler(server.Server.CreateHandler(), () => Interlocked.Increment(ref exchanges) == 1 && loseFirstResponse));
                return services.BuildServiceProvider();
            }
            var registration = new RegistrationRequest { MachineId = "office-agent-a", Hostname = "LAB", OsVersion = "Test", AgentVersion = "Test" };
            if (loseFirstResponse)
            {
                using var interrupted = Agent();
                Assert.Null(await interrupted.GetRequiredService<IServerClient>().RegisterAsync(registration, CancellationToken.None));
                Assert.True(File.Exists(provision));
                Assert.Contains("office-agent-a", await File.ReadAllTextAsync(state));
            }
            using (var agent = Agent())
            {
                var result = await agent.GetRequiredService<IServerClient>().RegisterAsync(registration, CancellationToken.None);
                Assert.NotNull(result);
                Assert.Equal(RegistrationStatus.Pending, result.Status);
            }
            Assert.False(File.Exists(provision));
            // Real Console.Core login and selected pending-identity approval, not a
            // direct approved-cabinet insert. Only the fixture operator is seeded.
            using (var scope = server.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
                var password = scope.ServiceProvider.GetRequiredService<IPasswordHasher>().Hash(ConsoleTestHost.KnownPassword);
                db.Users.Add(new CabinetPlatform.Server.Domain.User
                {
                    Username = "office-supervisor", DisplayName = "Office supervisor", Role = Role.Supervisor,
                    PasswordHash = password.Hash, PasswordSalt = password.Salt, PasswordIterations = password.Iterations,
                    IsActive = true, MustChangePassword = false, CreatedUtc = now,
                });
                await db.SaveChangesAsync();
            }
            var session = new SessionStore();
            using var consoleHttp = server.CreateDefaultClient(new BearerTokenHandler(session));
            var api = new ApiClient(consoleHttp, session);
            await api.LoginAsync(new LoginRequest { Username = "office-supervisor", Password = ConsoleTestHost.KnownPassword }, CancellationToken.None);
            var approvals = new RegistrationsViewModel(api, session, new RecordingLiveRegionAnnouncer());
            await approvals.LoadAsync();
            approvals.SelectedRegistration = Assert.Single(approvals.Queue);
            approvals.ClientName = "Authorized office lab";
            approvals.SiteName = "Disposable test site";
            approvals.CabinetRole = CabinetRole.Standalone;
            approvals.IdentityConfirmed = true;
            await approvals.AcceptCommand.ExecuteAsync(null);
            Assert.False(approvals.HasError, approvals.ErrorMessage);
            using (var restarted = Agent())
            {
                var transport = restarted.GetRequiredService<IServerClient>();
                var result = await transport.RegisterAsync(registration, CancellationToken.None);
                Assert.Equal(RegistrationStatus.Approved, result?.Status);
                var checkin = await transport.CheckInAsync(new CheckInPayload
                {
                    MachineId = registration.MachineId, CabinetId = result!.CabinetId,
                    AgentVersion = "Test", CollectedAtUtc = DateTimeOffset.UtcNow,
                }, CheckInTier.Heartbeat, CancellationToken.None);
                Assert.Equal(CheckInOutcome.Accepted, checkin.Outcome);
                var detail = await api.GetCabinetLatestAsync(result.CabinetId!.Value, CancellationToken.None);
                Assert.Equal("LAB", detail.Cabinet.Hostname);
                await VerifyOfficeMonitoringAsync(server.Services, restarted, consoleHttp, api, session,
                    result.CabinetId.Value, root, () => server.CreateClient());
            }
            var stored = await File.ReadAllTextAsync(state);
            Assert.DoesNotContain(token, stored);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private sealed class LostResponseHandler(HttpMessageHandler inner, Func<bool> shouldDrop) : DelegatingHandler(inner)
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = await base.SendAsync(request, cancellationToken);
            if (response.StatusCode == HttpStatusCode.NoContent && shouldDrop())
            {
                response.Dispose();
                throw new HttpRequestException("Synthetic response loss after durable token redemption.");
            }
            return response;
        }
    }

    private sealed class Identity : IMachineIdentityProvider
    {
        public string GetMachineId() => "office-agent-a";
    }
}
