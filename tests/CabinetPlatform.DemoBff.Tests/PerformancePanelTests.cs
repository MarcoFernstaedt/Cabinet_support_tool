using System.Net;
using System.Net.Http.Headers;
using System.Text;
using CabinetPlatform.DemoBff;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace CabinetPlatform.DemoBff.Tests;

public sealed class PerformancePanelTests : IDisposable
{
    private static readonly Guid Id = Guid.Parse("b3dcbf90-c029-4617-b9ad-486f280df11b");
    private readonly PanelFactory _factory = new();
    public void Dispose() => _factory.Dispose();
    private HttpClient Client() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    { AllowAutoRedirect = false, HandleCookies = false, BaseAddress = new Uri("https://demo.example") });
    private string Cookie() => "__Host-DemoSession=" + _factory.Services.GetRequiredService<DemoSessions>()
        .Create("private-staff-jwt", DateTimeOffset.UtcNow.AddMinutes(5));
    private static Task<HttpResponseMessage> Get(HttpClient client, string path, string? cookie = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (cookie is not null) request.Headers.TryAddWithoutValidation("Cookie", cookie);
        return client.SendAsync(request);
    }

    [Fact]
    public async Task Exact_panel_displays_measurements_states_and_provenance_without_browser_bearer()
    {
        using var client = Client();
        using var response = await Get(client, $"/cabinets/{Id}/performance", Cookie());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var html = await response.Content.ReadAsStringAsync();
        Assert.Contains("31", html);
        Assert.Contains("Unknown", html);
        Assert.Contains("9", html);
        Assert.Contains("2026-10-03", html);
        Assert.Contains("Current", html);
        Assert.Contains("Agent heartbeat", html);
        Assert.Contains($"/cabinets/{Id}", html);
        Assert.Equal($"/api/demo/cabinets/{Id}/performance", _factory.LastPath);
        Assert.Equal(new AuthenticationHeaderValue("Bearer", "private-staff-jwt"), _factory.Authorization);
        Assert.DoesNotContain("private-staff-jwt", html + response.Headers + response.Content.Headers);
        Assert.Contains("no-store", response.Headers.CacheControl?.ToString());
    }

    [Theory]
    [InlineData("missing", "No agent performance sample")]
    [InlineData("stale", "Stale")]
    [InlineData("unknown", "Unknown")]
    public async Task Non_current_states_are_not_presented_as_live(string state, string expected)
    {
        _factory.Body = $$"""{"cabinetId":"{{Id}}","state":"{{state}}","collectedAtUtc":{{(state == "stale" ? "\"2026-10-01T12:00:00Z\"" : "null")}},"receivedUtc":{{(state == "stale" ? "\"2026-10-01T12:00:10Z\"" : "null")}},"cpuPercent":null,"ramUsedPercent":null,"minFreeDiskPercent":null}""";
        using var response = await Get(Client(), $"/cabinets/{Id}/performance", Cookie());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains(expected, await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Anonymous_bad_id_and_upstream_denial_do_not_expose_data_or_redirect()
    {
        using var client = Client();
        Assert.Equal(HttpStatusCode.Unauthorized, (await Get(client, $"/cabinets/{Id}/performance")).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await Get(client, "/cabinets/not-a-guid/performance", Cookie())).StatusCode);
        Assert.Equal(0, _factory.Calls);
        _factory.Status = HttpStatusCode.TemporaryRedirect;
        using var denied = await Get(client, $"/cabinets/{Id}/performance", Cookie());
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
        Assert.Null(denied.Headers.Location);
        Assert.DoesNotContain("private-data", await denied.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("other-id", "{\"cabinetId\":\"a835bb9a-e5bc-4a93-ac7a-d47f8af809d5\",\"state\":\"current\",\"cpuPercent\":31}")]
    [InlineData("bad-state", "{\"cabinetId\":\"b3dcbf90-c029-4617-b9ad-486f280df11b\",\"state\":\"live\",\"cpuPercent\":31}")]
    [InlineData("bad-percent", "{\"cabinetId\":\"b3dcbf90-c029-4617-b9ad-486f280df11b\",\"state\":\"current\",\"cpuPercent\":200}")]
    public async Task Invalid_upstream_shape_is_denied(string _, string body)
    {
        _factory.Body = body;
        using var response = await Get(Client(), $"/cabinets/{Id}/performance", Cookie());
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.TemporaryRedirect)]
    public async Task Upstream_denial_is_not_proxied(HttpStatusCode status)
    {
        _factory.Status = status;
        using var denied = await Get(Client(), $"/cabinets/{Id}/performance", Cookie());
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
        Assert.Null(denied.Headers.Location);
        Assert.DoesNotContain("private-data", await denied.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Fresh_request_rechecks_scope_and_oversized_payload_is_denied()
    {
        using var client = Client();
        var cookie = Cookie();
        using var first = await Get(client, $"/cabinets/{Id}/performance", cookie);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        _factory.Status = HttpStatusCode.NotFound;
        using var revoked = await Get(client, $"/cabinets/{Id}/performance", cookie);
        Assert.Equal(HttpStatusCode.NotFound, revoked.StatusCode);
        Assert.Equal(2, _factory.Calls);
        _factory.Status = HttpStatusCode.OK;
        _factory.Body = $$"""{"cabinetId":"{{Id}}","state":"missing","padding":"{{new string('x', 9000)}}"}""";
        using var oversized = await Get(client, $"/cabinets/{Id}/performance", cookie);
        Assert.Equal(HttpStatusCode.NotFound, oversized.StatusCode);
    }

    private sealed class PanelFactory : WebApplicationFactory<Program>
    {
        public string? LastPath { get; private set; }
        public AuthenticationHeaderValue? Authorization { get; private set; }
        public int Calls { get; private set; }
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public string Body { get; set; } = $$"""{"cabinetId":"{{Id}}","state":"current","collectedAtUtc":"2026-10-03T12:00:00Z","receivedUtc":"2026-10-03T12:00:10Z","cpuPercent":31,"ramUsedPercent":null,"minFreeDiskPercent":9}""";
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            { ["DemoBff:PublicOrigin"] = "https://demo.example", ["DemoBff:ServerBaseUrl"] = "https://server.example" }));
            builder.ConfigureTestServices(services => services.AddHttpClient("server-login")
                .ConfigurePrimaryHttpMessageHandler(() => new Handler(this)));
        }
        private sealed class Handler(PanelFactory factory) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                factory.Calls++;
                factory.LastPath = request.RequestUri!.AbsolutePath;
                factory.Authorization = request.Headers.Authorization;
                Assert.Equal("server.example", request.RequestUri.Host);
                var response = new HttpResponseMessage(factory.Status)
                { Content = new StringContent(factory.Status == HttpStatusCode.OK ? factory.Body : "private-data", Encoding.UTF8, "application/json") };
                if ((int)factory.Status is >= 300 and < 400) response.Headers.Location = new Uri("https://foreign.example/collect");
                return Task.FromResult(response);
            }
        }
    }
}
