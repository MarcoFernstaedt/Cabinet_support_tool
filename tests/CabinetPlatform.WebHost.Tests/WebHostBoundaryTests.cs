using System.Net;
using CabinetPlatform.WebHost.Security;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Xunit;

namespace CabinetPlatform.WebHost.Tests;

public sealed class WebHostBoundaryTests
{
    [Fact]
    public void Host_refuses_to_start_without_explicit_Entra_configuration()
    {
        using var env = new EntraEnvironment(configured: false);
        using var factory = new WebApplicationFactory<Program>();
        Assert.Throws<InvalidOperationException>(() => factory.CreateClient());
    }

    [Fact]
    public async Task Anonymous_home_is_a_challenge_and_not_a_preview_or_data_page()
    {
        using var env = new EntraEnvironment(configured: true);
        using var factory = ConfiguredHost();
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost") });
        using var response = await client.GetAsync("/");
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal("/signin", response.Headers.Location?.AbsolutePath);
        using var challenge = await client.GetAsync(response.Headers.Location);
        Assert.Equal(HttpStatusCode.Redirect, challenge.StatusCode);
        Assert.Equal("login.microsoftonline.com", challenge.Headers.Location?.Host);
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(challenge.Headers.Location!.Query);
        Assert.Equal("code", query["response_type"].ToString());
        Assert.Equal("22222222-2222-2222-2222-222222222222", query["client_id"].ToString());
        Assert.Contains("\"acrs\":{\"essential\":true,\"value\":\"c1\"}", query["claims"].ToString());
        Assert.False(string.IsNullOrWhiteSpace(query["code_challenge"].ToString()));
        Assert.DoesNotContain("Sample application", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Anonymous_signout_post_is_denied_and_no_cabinet_routes_are_exposed()
    {
        using var env = new EntraEnvironment(configured: true);
        using var factory = ConfiguredHost();
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost") });
        using var signout = await client.PostAsync("/signout", null);
        Assert.Equal(HttpStatusCode.Redirect, signout.StatusCode);
        Assert.Equal("/signin", signout.Headers.Location?.AbsolutePath);
        using var cabinet = await client.GetAsync("/api/cabinets");
        Assert.NotEqual(HttpStatusCode.OK, cabinet.StatusCode);
        using var health = await client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
    }

    [Fact]
    public void Browser_session_is_http_only_secure_and_does_not_store_OIDC_tokens()
    {
        using var env = new EntraEnvironment(configured: true);
        using var factory = ConfiguredHost();
        var cookie = factory.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>().Get(CookieAuthenticationDefaults.AuthenticationScheme);
        var oidc = factory.Services.GetRequiredService<IOptionsMonitor<OpenIdConnectOptions>>().Get(OpenIdConnectDefaults.AuthenticationScheme);
        Assert.True(cookie.Cookie.HttpOnly);
        Assert.Equal(CookieSecurePolicy.Always, cookie.Cookie.SecurePolicy);
        Assert.Equal("__Host-CabinetWeb", cookie.Cookie.Name);
        Assert.False(cookie.SlidingExpiration);
        Assert.False(oidc.SaveTokens);
        Assert.True(oidc.UsePkce);
        Assert.True(oidc.RequireHttpsMetadata);
        Assert.Equal("code", oidc.ResponseType);
    }

    private static WebApplicationFactory<Program> ConfiguredHost() => new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
    {
        builder.ConfigureServices(services => services.PostConfigure<OpenIdConnectOptions>(OpenIdConnectDefaults.AuthenticationScheme,
            options => options.ConfigurationManager = new Microsoft.IdentityModel.Protocols.StaticConfigurationManager<OpenIdConnectConfiguration>(new OpenIdConnectConfiguration
            {
                AuthorizationEndpoint = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/authorize",
                TokenEndpoint = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
                Issuer = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0"
            })));
    });

    private sealed class EntraEnvironment : IDisposable
    {
        private readonly Dictionary<string, string?> _previous = new();
        public EntraEnvironment(bool configured)
        {
            var values = new Dictionary<string, string?>
            {
                ["WebConsole__Entra__TenantId"] = configured ? "11111111-1111-1111-1111-111111111111" : "",
                ["WebConsole__Entra__ClientId"] = configured ? "22222222-2222-2222-2222-222222222222" : "",
                ["WebConsole__Entra__ClientSecret"] = configured ? "synthetic-test-only" : "",
                ["WebConsole__Entra__RequiredAuthContext"] = configured ? "c1" : ""
            };
            foreach (var (key, value) in values)
            {
                _previous[key] = Environment.GetEnvironmentVariable(key);
                Environment.SetEnvironmentVariable(key, value);
            }
        }
        public void Dispose()
        {
            foreach (var (key, value) in _previous)
                Environment.SetEnvironmentVariable(key, value);
        }
    }
}
