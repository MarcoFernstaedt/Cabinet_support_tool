using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using CabinetPlatform.DemoBff;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;
using Xunit;

namespace CabinetPlatform.DemoBff.Tests;

public sealed class SessionTests : IDisposable
{
    private readonly DemoFactory _factory = new();
    public void Dispose() => _factory.Dispose();

    [Fact]
    public void Server_login_http_handler_never_follows_cross_origin_redirects()
    {
        using var factory = new RedirectConfigurationFactory();
        _ = factory.Services.GetRequiredService<IHttpClientFactory>().CreateClient("server-login");
        var handler = Assert.IsType<HttpClientHandler>(factory.Capture.PrimaryHandler);
        Assert.False(handler.AllowAutoRedirect);
    }

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

    [Theory]
    [InlineData(HttpStatusCode.TemporaryRedirect)]
    [InlineData(HttpStatusCode.PermanentRedirect)]
    public async Task Cross_origin_upstream_redirect_is_denied_without_session(HttpStatusCode status)
    {
        _factory.RedirectStatus = status;
        try
        {
            using var client = Client();
            var (csrf, cookie) = await Form(client);
            using var response = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(x => x.StartsWith("__Host-DemoSession=")));
            using var home = await Get(client, "/", cookie);
            Assert.DoesNotContain("Signed in", await home.Content.ReadAsStringAsync());
        }
        finally { _factory.RedirectStatus = null; }
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

    [Theory]
    [InlineData("not-a-date")]
    [InlineData("2026-99-99T00:00:00Z")]
    public async Task Malformed_expiry_is_denied_without_session(string expiry)
    {
        _factory.ExpiryOverride = expiry;
        try
        {
            using var client = Client();
            var (csrf, cookie) = await Form(client);
            using var response = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(x => x.StartsWith("__Host-DemoSession=")));
        }
        finally { _factory.ExpiryOverride = null; }
    }

    [Theory]
    [InlineData("\"Tier1\"", "true")]
    [InlineData("\"Guest\"", "false")]
    [InlineData("0", "false")]
    [InlineData("null", "false")]
    public async Task Restricted_or_invalid_identity_never_creates_session(string role, string mustChange)
    {
        _factory.LoginBodyOverride = "{\"accessToken\":\"fixture-access-token\",\"expiresAtUtc\":\"2099-01-01T00:00:00Z\",\"userId\":\"a835bb9a-e5bc-4a93-ac7a-d47f8af809d5\",\"role\":" + role + ",\"mustChangePassword\":" + mustChange + "}";
        try
        {
            using var client = Client();
            var (csrf, cookie) = await Form(client);
            using var response = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(x => x.StartsWith("__Host-DemoSession=")));
            using var home = await Get(client, "/", cookie);
            Assert.DoesNotContain("Signed in", await home.Content.ReadAsStringAsync());
        }
        finally { _factory.LoginBodyOverride = null; }
    }

    [Theory]
    [InlineData("\"userId\":\"00000000-0000-0000-0000-000000000000\",\"role\":\"Tier1\",\"mustChangePassword\":false")]
    [InlineData("\"userId\":\"not-a-guid\",\"role\":\"Tier1\",\"mustChangePassword\":false")]
    [InlineData("\"userId\":\"a835bb9a-e5bc-4a93-ac7a-d47f8af809d5\",\"role\":\"Tier1\"")]
    [InlineData("\"userId\":\"a835bb9a-e5bc-4a93-ac7a-d47f8af809d5\",\"mustChangePassword\":false")]
    public async Task Incomplete_or_malformed_identity_is_denied(string identityFields)
    {
        _factory.LoginBodyOverride = "{\"accessToken\":\"fixture-access-token\",\"expiresAtUtc\":\"2099-01-01T00:00:00Z\"," + identityFields + "}";
        try
        {
            using var client = Client();
            var (csrf, cookie) = await Form(client);
            using var response = await Post(client, "/login", csrf, cookie, "username=fixture&password=fixture-password");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(x => x.StartsWith("__Host-DemoSession=")));
        }
        finally { _factory.LoginBodyOverride = null; }
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

public sealed class RedirectConfigurationFactory : WebApplicationFactory<Program>
{
    public HandlerCapture Capture { get; } = new();
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DemoBff:PublicOrigin"] = "https://demo.example",
            ["DemoBff:ServerBaseUrl"] = "https://server.example"
        }));
        builder.ConfigureTestServices(services => services.AddSingleton<IHttpMessageHandlerBuilderFilter>(Capture));
    }
}

public sealed class HandlerCapture : IHttpMessageHandlerBuilderFilter
{
    public HttpMessageHandler? PrimaryHandler { get; private set; }
    public Action<HttpMessageHandlerBuilder> Configure(Action<HttpMessageHandlerBuilder> next) => builder =>
    {
        next(builder);
        PrimaryHandler = builder.PrimaryHandler;
    };
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
    public HttpStatusCode? RedirectStatus { get; set; }
    public string? ExpiryOverride { get; set; }
    public string? LoginBodyOverride { get; set; }
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
            if (factory.RedirectStatus is { } redirect)
                return new HttpResponseMessage(redirect) { Headers = { Location = new Uri("https://foreign.example/collect") } };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(factory.LoginBodyOverride ?? System.Text.Json.JsonSerializer.Serialize(new
            {
                accessToken = "fixture-access-token", refreshToken = "fixture-refresh-token",
                expiresAtUtc = factory.ExpiryOverride ?? (factory.Expired ? DateTimeOffset.UtcNow.AddMinutes(-1) : DateTimeOffset.UtcNow.AddMinutes(5)).ToString("O"),
                userId = "a835bb9a-e5bc-4a93-ac7a-d47f8af809d5", role = "Tier1", mustChangePassword = false
            })) };
        }
    }
}
