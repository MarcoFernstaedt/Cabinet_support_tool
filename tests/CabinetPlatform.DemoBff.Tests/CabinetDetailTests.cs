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

public sealed class CabinetDetailTests : IDisposable
{
    private static readonly Guid CabinetId = Guid.Parse("b3dcbf90-c029-4617-b9ad-486f280df11b");
    private readonly DetailFactory _factory = new();
    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Exact_granted_cabinet_displays_scoped_identity_with_server_held_bearer()
    {
        using var client = Client();
        var cookie = SignedInCookie();
        using var response = await Get(client, $"/cabinets/{CabinetId}", cookie);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var html = await response.Content.ReadAsStringAsync();
        Assert.Contains("Client Alpha", html);
        Assert.Contains("Site Beta", html);
        Assert.Contains("Cabinet Gamma", html);
        Assert.Contains("host-delta", html);
        Assert.Contains(CabinetId.ToString(), html);
        Assert.Equal("/api/demo/cabinets/" + CabinetId, _factory.LastPath);
        Assert.Equal("Bearer", _factory.LastAuthorization?.Scheme);
        Assert.Equal("secret-staff-jwt", _factory.LastAuthorization?.Parameter);
        Assert.DoesNotContain("secret-staff-jwt", html + response.Headers + response.Content.Headers);
        Assert.DoesNotContain(cookie, html + response.Headers + response.Content.Headers);
        Assert.Contains("no-store", response.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task Signed_in_home_offers_exact_id_navigation_without_listing_grants()
    {
        using var client = Client();
        using var response = await Get(client, "/", SignedInCookie());
        var html = await response.Content.ReadAsStringAsync();
        Assert.Contains("Cabinet ID", html);
        Assert.Contains("/cabinets/", html);
        Assert.DoesNotContain("Cabinet access is not enabled", html);
    }

    [Fact]
    public async Task Anonymous_and_revoked_sessions_never_reach_server()
    {
        using var client = Client();
        using var anonymous = await Get(client, $"/cabinets/{CabinetId}");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        var cookie = SignedInCookie();
        _factory.Services.GetRequiredService<DemoSessions>().Remove(cookie.Split('=')[1]);
        using var revoked = await Get(client, $"/cabinets/{CabinetId}", cookie);
        Assert.Equal(HttpStatusCode.Unauthorized, revoked.StatusCode);
        Assert.Equal(0, _factory.Calls);
    }

    [Theory]
    [InlineData("not-a-guid")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    [InlineData("b3dcbf90-c029-4617-b9ad-486f280df11b%2fapi%2fauth%2flogin")]
    public async Task Malformed_id_never_reaches_server(string id)
    {
        using var client = Client();
        using var response = await Get(client, "/cabinets/" + id, SignedInCookie());
        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, _factory.Calls);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.TemporaryRedirect)]
    [InlineData(HttpStatusCode.PermanentRedirect)]
    public async Task Upstream_denial_and_redirect_never_return_content_or_location(HttpStatusCode status)
    {
        _factory.DetailStatus = status;
        _factory.DetailBody = "private-upstream-error";
        using var client = Client();
        using var response = await Get(client, $"/cabinets/{CabinetId}", SignedInCookie());
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.DoesNotContain("private-upstream-error", await response.Content.ReadAsStringAsync());
        Assert.False(response.Headers.Location is not null);
        Assert.Equal(1, _factory.Calls);
    }

    [Fact]
    public async Task Client_site_cabinet_and_hostname_script_text_is_html_escaped()
    {
        _factory.DetailBody = $$"""{"cabinetId":"{{CabinetId}}","hostname":"<script>host</script>","friendlyName":"<img src=x onerror=alert(1)>","siteName":"<script>site</script>","clientName":"<script>client</script>"}""";
        using var client = Client();
        using var response = await Get(client, $"/cabinets/{CabinetId}", SignedInCookie());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var html = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("<script>", html);
        Assert.DoesNotContain("<img", html);
        Assert.Contains("&lt;script&gt;client&lt;/script&gt;", html);
        Assert.Contains("&lt;script&gt;site&lt;/script&gt;", html);
        Assert.Contains("&lt;script&gt;host&lt;/script&gt;", html);
        Assert.Contains("&lt;img src=x onerror=alert(1)&gt;", html);
    }

    [Fact]
    public async Task Detail_is_fetched_on_every_visit_so_revoked_grant_takes_effect()
    {
        using var client = Client();
        var cookie = SignedInCookie();
        using var first = await Get(client, $"/cabinets/{CabinetId}", cookie);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        _factory.DetailStatus = HttpStatusCode.NotFound;
        using var second = await Get(client, $"/cabinets/{CabinetId}", cookie);
        Assert.Equal(HttpStatusCode.NotFound, second.StatusCode);
        Assert.Equal(2, _factory.Calls);
    }

    [Theory]
    [InlineData("{\"cabinetId\":\"a835bb9a-e5bc-4a93-ac7a-d47f8af809d5\",\"hostname\":\"other\",\"friendlyName\":\"other\",\"siteName\":\"other\",\"clientName\":\"other\"}")]
    [InlineData("{\"cabinetId\":\"b3dcbf90-c029-4617-b9ad-486f280df11b\",\"hostname\":null,\"friendlyName\":\"name\",\"siteName\":\"site\",\"clientName\":\"client\"}")]
    [InlineData("not-json")]
    public async Task Untrusted_upstream_shape_is_denied(string body)
    {
        _factory.DetailBody = body;
        using var client = Client();
        using var response = await Get(client, $"/cabinets/{CabinetId}", SignedInCookie());
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.DoesNotContain("other", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Expired_session_cannot_read_detail()
    {
        using var client = Client();
        var cookie = "__Host-DemoSession=" + _factory.Services.GetRequiredService<DemoSessions>()
            .Create("secret-staff-jwt", DateTimeOffset.UtcNow.AddSeconds(-1));
        using var response = await Get(client, $"/cabinets/{CabinetId}", cookie);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(0, _factory.Calls);
    }

    [Fact]
    public async Task Cabinet_id_form_redirects_only_valid_id_to_exact_detail_path()
    {
        using var client = Client();
        var cookie = SignedInCookie();
        using var valid = await Get(client, $"/cabinets/?id={CabinetId}", cookie);
        Assert.Equal(HttpStatusCode.Found, valid.StatusCode);
        Assert.Equal($"/cabinets/{CabinetId}", valid.Headers.Location?.OriginalString);
        using var invalid = await Get(client, "/cabinets/?id=../api/auth/login", cookie);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Equal(0, _factory.Calls);
    }

    [Fact]
    public async Task Oversized_upstream_body_is_denied_without_rendering()
    {
        _factory.DetailBody = new string('x', 9000);
        using var client = Client();
        using var response = await Get(client, $"/cabinets/{CabinetId}", SignedInCookie());
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.DoesNotContain("xxx", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Cabinet_without_optional_friendly_name_displays_hostname()
    {
        _factory.DetailBody = $$"""{"cabinetId":"{{CabinetId}}","hostname":"host-delta","friendlyName":null,"siteName":"Site Beta","clientName":"Client Alpha"}""";
        using var client = Client();
        using var response = await Get(client, $"/cabinets/{CabinetId}", SignedInCookie());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("<h1>host-delta</h1>", await response.Content.ReadAsStringAsync());
    }

    private HttpClient Client() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false, HandleCookies = false, BaseAddress = new Uri("https://demo.example")
    });
    private string SignedInCookie() => "__Host-DemoSession=" + _factory.Services.GetRequiredService<DemoSessions>()
        .Create("secret-staff-jwt", DateTimeOffset.UtcNow.AddMinutes(5));
    private static Task<HttpResponseMessage> Get(HttpClient client, string path, string? cookie = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (cookie is not null) request.Headers.TryAddWithoutValidation("Cookie", cookie);
        return client.SendAsync(request);
    }

    private sealed class DetailFactory : WebApplicationFactory<Program>
    {
        public string? LastPath { get; private set; }
        public AuthenticationHeaderValue? LastAuthorization { get; private set; }
        public int Calls { get; private set; }
        public HttpStatusCode DetailStatus { get; set; } = HttpStatusCode.OK;
        public string DetailBody { get; set; } = $$"""{"cabinetId":"{{CabinetId}}","hostname":"host-delta","friendlyName":"Cabinet Gamma","siteName":"Site Beta","clientName":"Client Alpha"}""";
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["DemoBff:PublicOrigin"] = "https://demo.example",
                ["DemoBff:ServerBaseUrl"] = "https://server.example"
            }));
            builder.ConfigureTestServices(services => services.AddHttpClient("server-login")
                .ConfigurePrimaryHttpMessageHandler(() => new DetailHandler(this)));
        }
        private sealed class DetailHandler(DetailFactory factory) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                factory.Calls++;
                factory.LastPath = request.RequestUri!.AbsolutePath;
                factory.LastAuthorization = request.Headers.Authorization;
                Assert.Equal("server.example", request.RequestUri.Host);
                var response = new HttpResponseMessage(factory.DetailStatus)
                {
                    Content = new StringContent(factory.DetailBody, Encoding.UTF8, "application/json")
                };
                if ((int)factory.DetailStatus is >= 300 and < 400)
                    response.Headers.Location = new Uri("https://foreign.example/collect");
                return Task.FromResult(response);
            }
        }
    }
}
