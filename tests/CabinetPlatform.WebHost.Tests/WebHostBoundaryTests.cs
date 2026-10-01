using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.IdentityModel.Tokens.Jwt;
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
using Microsoft.IdentityModel.Tokens;
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

    [Theory]
    [InlineData("c1", true)]
    [InlineData("c2", false)]
    [InlineData("", false)]
    public async Task Signed_callback_only_creates_browser_session_for_required_context(string context, bool accepted)
    {
        using var env = new EntraEnvironment(configured: true);
        using var rsa = RSA.Create(2048);
        var signingKey = new RsaSecurityKey(rsa) { KeyId = "synthetic-key" };
        using var backchannel = new TokenBackchannel(signingKey);
        using var factory = ConfiguredHost(backchannel, signingKey);
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost") });
        using var challenge = await client.GetAsync("/signin");
        Assert.Equal(HttpStatusCode.Redirect, challenge.StatusCode);
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(challenge.Headers.Location!.Query);
        backchannel.Nonce = query["nonce"].ToString();
        backchannel.AuthContext = context;
        using var callback = await client.PostAsync("/signin-oidc", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = "synthetic-code", ["state"] = query["state"].ToString()
        }));
        Assert.Equal(accepted ? HttpStatusCode.Redirect : HttpStatusCode.Forbidden, callback.StatusCode);
        using var home = await client.GetAsync("/");
        Assert.Equal(accepted ? HttpStatusCode.OK : HttpStatusCode.Redirect, home.StatusCode);
        if (accepted)
        {
            Assert.Contains("Signed in as", await home.Content.ReadAsStringAsync());
            Assert.DoesNotContain("<script>", await home.Content.ReadAsStringAsync());
            using var replay = await client.PostAsync("/signin-oidc", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["code"] = "synthetic-code", ["state"] = query["state"].ToString()
            }));
            Assert.Equal(HttpStatusCode.Forbidden, replay.StatusCode);
        }
    }

    [Theory]
    [InlineData("issuer")]
    [InlineData("audience")]
    [InlineData("nonce")]
    [InlineData("signature")]
    [InlineData("expiry")]
    public async Task Signed_callback_rejects_invalid_token_binding(string tamper)
    {
        using var env = new EntraEnvironment(configured: true);
        using var rsa = RSA.Create(2048);
        var key = new RsaSecurityKey(rsa) { KeyId = "synthetic-key" };
        using var backchannel = new TokenBackchannel(key) { AuthContext = "c1" };
        using var otherRsa = RSA.Create(2048);
        if (tamper == "signature") backchannel.TokenSigningKey = new RsaSecurityKey(otherRsa) { KeyId = "synthetic-key" };
        if (tamper == "expiry") backchannel.Expired = true;
        using var factory = ConfiguredHost(backchannel, key);
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost") });
        using var challenge = await client.GetAsync("/signin");
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(challenge.Headers.Location!.Query);
        backchannel.Nonce = tamper == "nonce" ? "wrong-nonce" : query["nonce"].ToString();
        if (tamper == "issuer") backchannel.Issuer = "https://untrusted.example/v2.0";
        if (tamper == "audience") backchannel.Audience = "44444444-4444-4444-4444-444444444444";
        using var callback = await client.PostAsync("/signin-oidc", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = "synthetic-code", ["state"] = query["state"].ToString()
        }));
        Assert.Equal(HttpStatusCode.Forbidden, callback.StatusCode);
        using var home = await client.GetAsync("/");
        Assert.Equal(HttpStatusCode.Redirect, home.StatusCode);
    }

    [Fact]
    public async Task Authenticated_signout_requires_csrf_token()
    {
        using var env = new EntraEnvironment(configured: true);
        using var rsa = RSA.Create(2048);
        var key = new RsaSecurityKey(rsa) { KeyId = "synthetic-key" };
        using var backchannel = new TokenBackchannel(key) { AuthContext = "c1" };
        using var factory = ConfiguredHost(backchannel, key);
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost") });
        using var challenge = await client.GetAsync("/signin");
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(challenge.Headers.Location!.Query);
        backchannel.Nonce = query["nonce"].ToString();
        using var callback = await client.PostAsync("/signin-oidc", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = "synthetic-code", ["state"] = query["state"].ToString()
        }));
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        using var home = await client.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, home.StatusCode);
        using var signout = await client.PostAsync("/signout", null);
        Assert.Equal(HttpStatusCode.BadRequest, signout.StatusCode);
        using var stillSignedIn = await client.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, stillSignedIn.StatusCode);
        var html = await stillSignedIn.Content.ReadAsStringAsync();
        var token = System.Text.RegularExpressions.Regex.Match(html, "name=\"__RequestVerificationToken\" value=\"([^\"]+)\"").Groups[1].Value;
        Assert.NotEmpty(token);
        using var validSignout = await client.PostAsync("/signout", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["__RequestVerificationToken"] = token
        }));
        Assert.Equal(HttpStatusCode.Redirect, validSignout.StatusCode);
        Assert.Equal("login.microsoftonline.com", validSignout.Headers.Location?.Host);
        using var afterSignout = await client.GetAsync("/");
        Assert.Equal(HttpStatusCode.Redirect, afterSignout.StatusCode);
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

    private static WebApplicationFactory<Program> ConfiguredHost(TokenBackchannel? tokenBackchannel = null, SecurityKey? signingKey = null) => new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
    {
        builder.ConfigureServices(services => services.PostConfigure<OpenIdConnectOptions>(OpenIdConnectDefaults.AuthenticationScheme,
            options =>
            {
                var configuration = new OpenIdConnectConfiguration
                {
                    AuthorizationEndpoint = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/authorize",
                    TokenEndpoint = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
                    EndSessionEndpoint = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/logout",
                    Issuer = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0"
                };
                if (signingKey is not null) configuration.SigningKeys.Add(signingKey);
                options.ConfigurationManager = new Microsoft.IdentityModel.Protocols.StaticConfigurationManager<OpenIdConnectConfiguration>(configuration);
                if (tokenBackchannel is not null) options.Backchannel = new HttpClient(tokenBackchannel);
            }));
    });

    private sealed class TokenBackchannel(SecurityKey signingKey) : HttpMessageHandler
    {
        public string Nonce { get; set; } = "";
        public string AuthContext { get; set; } = "";
        public string Issuer { get; set; } = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0";
        public string Audience { get; set; } = "22222222-2222-2222-2222-222222222222";
        public SecurityKey TokenSigningKey { get; set; } = signingKey;
        public bool Expired { get; set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.EndsWith("/token", request.RequestUri?.AbsolutePath);
            var claims = new List<Claim>
            {
                new("sub", "synthetic-subject"),
                new("tid", "11111111-1111-1111-1111-111111111111"),
                new("oid", "33333333-3333-3333-3333-333333333333"),
                new("nonce", Nonce),
                new("name", "<script>alert(1)</script>")
            };
            if (AuthContext.Length > 0) claims.Add(new Claim("acrs", AuthContext));
            var token = new JwtSecurityTokenHandler().CreateEncodedJwt(new SecurityTokenDescriptor
            {
                Issuer = Issuer,
                Audience = Audience,
                Subject = new ClaimsIdentity(claims),
                NotBefore = Expired ? DateTime.UtcNow.AddMinutes(-20) : DateTime.UtcNow,
                IssuedAt = Expired ? DateTime.UtcNow.AddMinutes(-20) : DateTime.UtcNow,
                Expires = Expired ? DateTime.UtcNow.AddMinutes(-10) : DateTime.UtcNow.AddMinutes(10),
                SigningCredentials = new SigningCredentials(TokenSigningKey, SecurityAlgorithms.RsaSha256)
            });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new { access_token = "synthetic-only", id_token = token, token_type = "Bearer", expires_in = 600 })
            });
        }
    }

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
