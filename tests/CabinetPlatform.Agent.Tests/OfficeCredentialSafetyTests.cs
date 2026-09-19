using System.Net;
using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Transport;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Tests;

public sealed class OfficeCredentialSafetyTests
{
    [Fact]
    public async Task Trace_http_logs_never_contain_the_device_key()
    {
        const string secret = "synthetic-sensitive-device-key";
        var logs = new CapturingLogs();
        var services = new ServiceCollection();
        services.AddLogging(builder => builder.SetMinimumLevel(LogLevel.Trace).AddProvider(logs));
        services.AddCabinetAgent(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Agent:ServerBaseUrl"] = "https://trusted.example/"
        }).Build());
        services.AddSingleton<IMachineIdentityProvider>(new Identity());
        services.AddSingleton<IAgentCredentialProvider>(new Credential(secret));
        services.AddHttpClient("cabinet-server").ConfigurePrimaryHttpMessageHandler(() => new CountingHandler());
        using var provider = services.BuildServiceProvider();
        using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("cabinet-server");
        using var response = await client.GetAsync("api/agent/actions");
        Assert.NotEmpty(logs.Lines);
        Assert.DoesNotContain(secret, string.Join("\n", logs.Lines));
    }

    [Fact]
    public async Task Miswired_enrollment_client_cannot_receive_the_token()
    {
        var directory = Path.Combine(Path.GetTempPath(), "office-origin-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var provision = Path.Combine(directory, "provision.json");
        await File.WriteAllTextAsync(provision, JsonSerializer.Serialize(new
        {
            ServerBaseUrl = "https://trusted.example/", Token = new string('A', 64)
        }));
        try
        {
            using var handler = new CountingHandler();
            using var client = new HttpClient(handler) { BaseAddress = new Uri("https://wrong.example/") };
            using var credentials = new OfficeAgentCredentialProvider(new ClientFactory(client), new Identity(), Options.Create(new AgentOptions
            {
                ServerBaseUrl = "https://trusted.example/", OfficeEnrollmentFile = provision
            }));
            await Assert.ThrowsAsync<InvalidOperationException>(() => credentials.EnsureKeyAsync(CancellationToken.None));
            Assert.Equal(0, handler.Requests);
            Assert.Null(credentials.GetAgentKey());
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData("http://trusted.example/")]
    [InlineData("https://other.example/api/agent/register")]
    [InlineData("https://user@trusted.example/api/agent/register")]
    public void Authenticated_requests_cannot_carry_credentials_to_a_different_origin(string destination)
    {
        using var client = new HttpClient();
        using var credentials = new OfficeAgentCredentialProvider(new ClientFactory(client), new Identity(), Options.Create(new AgentOptions
        {
            ServerBaseUrl = "https://trusted.example/", OfficeEnrollmentFile = "not-read.json"
        }));
        Assert.Throws<InvalidOperationException>(() => credentials.ValidateDestination(new Uri(destination)));
    }

    private sealed class Credential(string key) : IAgentCredentialProvider { public string GetAgentKey() => key; }
    private sealed class CapturingLogs : ILoggerProvider, ILogger
    {
        public List<string> Lines { get; } = [];
        public ILogger CreateLogger(string categoryName) => this;
        public void Dispose() { }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => Lines.Add(formatter(state, exception));
    }
    private sealed class Identity : IMachineIdentityProvider { public string GetMachineId() => "device"; }
    private sealed class ClientFactory(HttpClient client) : IHttpClientFactory { public HttpClient CreateClient(string name) => client; }
    private sealed class CountingHandler : HttpMessageHandler
    {
        public int Requests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
        }
    }
}
