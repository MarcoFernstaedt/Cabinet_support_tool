using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using CabinetPlatform.DemoBff;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace CabinetPlatform.DemoBff.Tests;

public sealed class SessionTests : IClassFixture<DemoFactory>
{
    private readonly DemoFactory _factory;
    public SessionTests(DemoFactory factory) => _factory = factory;

    [Fact]
    public void Server_side_session_enforces_upstream_expiry_and_idle_cap_without_sliding_absolute_expiry()
    {
        var clock = new FixtureClock();
        var sessions = new DemoSessions(clock);
        var key = sessions.Create("private-bearer", clock.GetUtcNow().AddMinutes(12))!;
        Assert.True(sessions.Valid(key));
        clock.Advance(TimeSpan.FromMinutes(9));
        Assert.True(sessions.Valid(key));
        clock.Advance(TimeSpan.FromMinutes(3));
        Assert.False(sessions.Valid(key));
        var idle = sessions.Create("private-bearer", clock.GetUtcNow().AddHours(1))!;
        clock.Advance(TimeSpan.FromMinutes(10));
        Assert.False(sessions.Valid(idle));
    }

    [Fact]
    public async Task Login_keeps_bearer_server_side_and_logout_revokes_session()
    {
        using var client = Client();
        var (csrf, cookie) = await Form(client);
        using var response = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password");
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var sessionCookie = response.Headers.GetValues("Set-Cookie").Single(x => x.StartsWith("__Host-DemoSession="));
        Assert.Contains("secure", sessionCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("httponly", sessionCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", sessionCookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("fixture-access-token", sessionCookie + body);
        Assert.DoesNotContain("fixture-refresh-token", sessionCookie + body);
        var joined = cookie + "; " + sessionCookie.Split(';')[0];
        using var home = await Get(client, "/", joined);
        Assert.Contains("Signed in", await home.Content.ReadAsStringAsync());
        var logoutToken = Token(await home.Content.ReadAsStringAsync());
        using var logout = await Post(client, "/logout", logoutToken, joined, "");
        Assert.Equal(HttpStatusCode.Found, logout.StatusCode);
        using var after = await Get(client, "/", joined);
        Assert.DoesNotContain("Signed in", await after.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Denial_never_creates_session_or_sample_fallback()
    {
        using var client = Client();
        var (csrf, cookie) = await Form(client);
        using var response = await Post(client, "/login", csrf, cookie, "username=fixture&password=wrong");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.DoesNotContain("__Host-DemoSession", string.Join(";", response.Headers.TryGetValues("Set-Cookie", out var values) ? values : []));
        Assert.DoesNotContain("fixture", await response.Content.ReadAsStringAsync());
        using var route = await Get(client, "/api/cabinets", cookie);
        Assert.Equal(HttpStatusCode.NotFound, route.StatusCode);
    }

    [Fact]
    public async Task Csrf_and_origin_are_both_required_for_login_and_logout()
    {
        using var client = Client();
        var (csrf, cookie) = await Form(client);
        using var missing = await Post(client, "/login", "", cookie, "username=fixture&password=fixture-password");
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        using var foreign = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password", "https://evil.example");
        Assert.Equal(HttpStatusCode.BadRequest, foreign.StatusCode);
        using var success = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password");
        var session = success.Headers.GetValues("Set-Cookie").Single(x => x.StartsWith("__Host-DemoSession=")).Split(';')[0];
        using var noLogout = await Post(client, "/logout", "", cookie + "; " + session, "");
        Assert.Equal(HttpStatusCode.BadRequest, noLogout.StatusCode);
        using var home = await Get(client, "/", cookie + "; " + session);
        Assert.Contains("Signed in", await home.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Expired_upstream_token_cannot_create_session()
    {
        _factory.Expired = true;
        try
        {
            using var client = Client();
            var (csrf, cookie) = await Form(client);
            using var response = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(x => x.StartsWith("__Host-DemoSession=")));
        }
        finally { _factory.Expired = false; }
    }

    [Fact]
    public async Task Unknown_length_login_body_is_rejected_before_credentials_reach_server()
    {
        using var client = Client();
        var (csrf, cookie) = await Form(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/login");
        request.Headers.TryAddWithoutValidation("Origin", "https://demo.example");
        request.Headers.TryAddWithoutValidation("Cookie", cookie);
        request.Content = new StreamContent(new NonSeekableStream(Encoding.UTF8.GetBytes("username=fixture&password=fixture-password&__RequestVerificationToken=" + Uri.EscapeDataString(csrf))));
        request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/x-www-form-urlencoded");
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    private HttpClient Client() => _factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false, BaseAddress = new Uri("https://demo.example") });
    private static async Task<(string token, string cookie)> Form(HttpClient client)
    {
        using var response = await client.GetAsync("/");
        return (Token(await response.Content.ReadAsStringAsync()), string.Join("; ", response.Headers.GetValues("Set-Cookie").Select(x => x.Split(';')[0])));
    }
    private static string Token(string html) => Regex.Match(html, "name=\"__RequestVerificationToken\" value=\"([^\"]+)\"").Groups[1].Value;
    private static Task<HttpResponseMessage> Get(HttpClient client, string path, string cookies)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.TryAddWithoutValidation("Cookie", cookies);
        return client.SendAsync(request);
    }
    private static Task<HttpResponseMessage> Post(HttpClient client, string path, string csrf, string cookie, string form, string origin = "https://demo.example")
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path);
        request.Headers.TryAddWithoutValidation("Origin", origin);
        request.Headers.TryAddWithoutValidation("Cookie", cookie);
        request.Content = new StringContent((form.Length == 0 ? "" : form + "&") + "__RequestVerificationToken=" + Uri.EscapeDataString(csrf), Encoding.UTF8, "application/x-www-form-urlencoded");
        return client.SendAsync(request);
    }
}

public sealed class NonSeekableStream(byte[] bytes) : MemoryStream(bytes)
{
    public override bool CanSeek => false;
}

public sealed class FixtureClock : TimeProvider
{
    private DateTimeOffset _now = DateTimeOffset.UtcNow;
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan elapsed) => _now += elapsed;
}

public sealed class DemoFactory : WebApplicationFactory<Program>
{
    public bool Expired { get; set; }
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DemoBff:PublicOrigin"] = "https://demo.example",
            ["DemoBff:ServerBaseUrl"] = "https://server.example"
        }));
        builder.ConfigureTestServices(services => services.AddHttpClient("server-login").ConfigurePrimaryHttpMessageHandler(() => new FixtureHandler(this)));
    }
    private sealed class FixtureHandler(DemoFactory factory) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("/api/auth/login", request.RequestUri!.AbsolutePath);
            var payload = await request.Content!.ReadAsStringAsync(cancellationToken);
            if (!payload.Contains("fixture-password")) return new HttpResponseMessage(HttpStatusCode.Forbidden);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(System.Text.Json.JsonSerializer.Serialize(new
            {
                accessToken = "fixture-access-token", refreshToken = "fixture-refresh-token",
                expiresAtUtc = factory.Expired ? DateTimeOffset.UtcNow.AddMinutes(-1) : DateTimeOffset.UtcNow.AddMinutes(5)
            })) };
        }
    }
}
