using System.Net;
using System.Security.Claims;
using System.Text.Json;
using CabinetPlatform.WebHost.Security;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Authorization;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

var builder = WebApplication.CreateBuilder(args);
var entra = builder.Configuration.GetSection(EntraWebOptions.Section).Get<EntraWebOptions>() ?? new EntraWebOptions();
entra.Validate(); // No preview bypass or password-only browser fallback.

builder.Services.AddAntiforgery(options => options.Cookie.SecurePolicy = CookieSecurePolicy.Always);
builder.Services.AddAuthentication(options =>
{
    options.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = OpenIdConnectDefaults.AuthenticationScheme;
})
.AddCookie(options =>
{
    options.Cookie.Name = "__Host-CabinetWeb";
    options.Cookie.HttpOnly = true;
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.Cookie.Path = "/";
    options.LoginPath = "/signin";
    options.ExpireTimeSpan = TimeSpan.FromMinutes(30);
    options.SlidingExpiration = false;
    options.Events.OnValidatePrincipal = context =>
    {
        if (!EntraAssurance.IsSatisfied(context.Principal, entra)) context.RejectPrincipal();
        return Task.CompletedTask;
    };
})
.AddOpenIdConnect(options =>
{
    options.Authority = $"https://login.microsoftonline.com/{entra.TenantId}/v2.0";
    options.ClientId = entra.ClientId;
    options.ClientSecret = entra.ClientSecret;
    options.ResponseType = OpenIdConnectResponseType.Code;
    options.UsePkce = true;
    options.SaveTokens = false;
    options.RequireHttpsMetadata = true;
    options.MapInboundClaims = false;
    options.TokenValidationParameters.ValidateIssuer = true;
    options.TokenValidationParameters.ValidIssuer = $"https://login.microsoftonline.com/{entra.TenantId}/v2.0";
    options.TokenValidationParameters.ValidateAudience = true;
    options.Events = new OpenIdConnectEvents
    {
        OnRedirectToIdentityProvider = context =>
        {
            // The tenant must configure and enforce this authentication context
            // with Conditional Access. A simple app-side "MFA enabled" flag is not evidence.
            context.ProtocolMessage.SetParameter("claims", JsonSerializer.Serialize(new
            {
                id_token = new { acrs = new { essential = true, value = entra.RequiredAuthContext } }
            }));
            return Task.CompletedTask;
        },
        OnTokenValidated = context =>
        {
            if (!EntraAssurance.IsSatisfied(context.Principal, entra))
                context.Fail("Required Entra tenant and authentication context were not proven.");
            return Task.CompletedTask;
        }
    };
});
builder.Services.AddAuthorization(options =>
{
    options.FallbackPolicy = new AuthorizationPolicyBuilder(CookieAuthenticationDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .RequireAssertion(context => EntraAssurance.IsSatisfied(context.User, entra))
        .Build();
});

var app = builder.Build();
app.UseHsts();
app.UseHttpsRedirection();
app.Use(async (context, next) =>
{
    context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers.CacheControl = "no-store";
    await next();
});
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "running" })).AllowAnonymous();
app.MapGet("/signed-out", () => Results.Content("Signed out of the Cabinet web session. Close your browser on a shared computer.", "text/plain; charset=utf-8")).AllowAnonymous();
app.MapGet("/signin", () => Results.Challenge(authenticationSchemes: [OpenIdConnectDefaults.AuthenticationScheme])).AllowAnonymous();
app.MapGet("/", (ClaimsPrincipal principal, IAntiforgery antiforgery, HttpContext context) =>
{
    var name = WebUtility.HtmlEncode(principal.FindFirst("name")?.Value ?? "Signed-in staff member");
    var token = WebUtility.HtmlEncode(antiforgery.GetAndStoreTokens(context).RequestToken ?? "");
    return Results.Content($"""
        <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cabinet Support</title></head>
        <body><main><h1>Cabinet Support</h1><p>Signed in as {name}.</p><p>The cabinet data adapter is not enabled yet.</p>
        <form method="post" action="/signout"><input type="hidden" name="__RequestVerificationToken" value="{token}"><button>Sign out</button></form></main></body></html>
        """, "text/html; charset=utf-8");
});
app.MapPost("/signout", async (HttpContext context, IAntiforgery antiforgery) =>
{
    await antiforgery.ValidateRequestAsync(context);
    return Results.SignOut(new AuthenticationProperties { RedirectUri = "/signed-out" },
        [CookieAuthenticationDefaults.AuthenticationScheme, OpenIdConnectDefaults.AuthenticationScheme]);
});

app.Run();
public partial class Program;
