using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.RateLimiting;
using CabinetPlatform.DemoBff;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<DemoSessions>();
builder.Services.AddAntiforgery(o =>
{
    o.Cookie.Name = "__Host-DemoCsrf";
    o.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    o.Cookie.HttpOnly = true;
    o.Cookie.SameSite = SameSiteMode.Strict;
});
builder.Services.AddHttpClient("server-login", (provider, client) =>
{
    client.BaseAddress = RequireHttpsRoot(provider.GetRequiredService<IConfiguration>()["DemoBff:ServerBaseUrl"]);
    client.Timeout = TimeSpan.FromSeconds(10);
    client.MaxResponseContentBufferSize = 8192;
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("ingress", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});
var app = builder.Build();
var origin = RequireHttpsRoot(app.Configuration["DemoBff:PublicOrigin"]);
_ = RequireHttpsRoot(app.Configuration["DemoBff:ServerBaseUrl"]);
app.UseHsts();
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers.CacheControl = "no-store";
    ctx.Response.Headers.ContentSecurityPolicy = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    if (!ctx.Request.IsHttps || !string.Equals(ctx.Request.Host.Value, origin.Authority, StringComparison.OrdinalIgnoreCase))
    {
        ctx.Response.StatusCode = 400;
        return;
    }
    await next();
});
app.UseRateLimiter();

app.MapGet("/", (HttpContext ctx, IAntiforgery antiforgery, DemoSessions sessions) =>
{
    var active = ctx.Request.Cookies.TryGetValue("__Host-DemoSession", out var cookie) && sessions.Valid(cookie);
    var csrf = WebUtility.HtmlEncode(antiforgery.GetAndStoreTokens(ctx).RequestToken ?? "");
    var html = active
        ? $"<h1>Signed in (demo only)</h1><p>Only exact cabinet IDs with an active staff grant can be read. No fleet listing or MFA is enabled.</p><form method=\"get\" action=\"/cabinets/\"><label>Cabinet ID<input name=\"id\" required autocomplete=\"off\"></label><button>Open cabinet</button></form><form method=\"post\" action=\"/logout\"><input type=\"hidden\" name=\"__RequestVerificationToken\" value=\"{csrf}\"><button>Log out</button></form>"
        : $"<h1>Cabinet demo sign in</h1><p>Demo only; no MFA or cabinet access.</p><form method=\"post\" action=\"/login\"><label>Username<input name=\"username\" required autocomplete=\"username\"></label><label>Password<input name=\"password\" type=\"password\" required autocomplete=\"current-password\"></label><input type=\"hidden\" name=\"__RequestVerificationToken\" value=\"{csrf}\"><button>Sign in</button></form>";
    return Results.Content("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Cabinet demo</title></head><body><main>" + html + "</main></body></html>", "text/html; charset=utf-8");
});

app.MapGet("/cabinets/", (HttpContext ctx, DemoSessions sessions) =>
{
    if (!ctx.Request.Cookies.TryGetValue("__Host-DemoSession", out var cookie) || !sessions.Valid(cookie))
        return Results.Unauthorized();
    var id = ctx.Request.Query["id"].ToString();
    if (!Guid.TryParseExact(id, "D", out var cabinetId) || cabinetId == Guid.Empty)
        return Results.BadRequest("Invalid cabinet ID.");
    return Results.Redirect($"/cabinets/{cabinetId:D}");
});

app.MapGet("/cabinets/{id}", async (string id, HttpContext ctx, DemoSessions sessions, IHttpClientFactory clients) =>
{
    if (!ctx.Request.Cookies.TryGetValue("__Host-DemoSession", out var cookie) ||
        !sessions.TryGetToken(cookie, out var token)) return Results.Unauthorized();
    if (!Guid.TryParseExact(id, "D", out var cabinetId) || cabinetId == Guid.Empty)
        return Results.BadRequest("Invalid cabinet ID.");
    try
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"api/demo/cabinets/{cabinetId:D}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await clients.CreateClient("server-login").SendAsync(request, HttpCompletionOption.ResponseContentRead, ctx.RequestAborted);
        if (response.StatusCode != HttpStatusCode.OK) return Results.NotFound();
        var detail = await response.Content.ReadFromJsonAsync<DemoCabinetDetail>(cancellationToken: ctx.RequestAborted);
        if (detail is null || detail.CabinetId != cabinetId ||
            !SafeLabel(detail.Hostname) || (detail.FriendlyName is { Length: > 256 }) ||
            !SafeLabel(detail.SiteName) || !SafeLabel(detail.ClientName)) return Results.NotFound();
        var title = string.IsNullOrWhiteSpace(detail.FriendlyName) ? detail.Hostname : detail.FriendlyName;
        var html = $"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Cabinet detail</title></head><body><main><h1>{WebUtility.HtmlEncode(title)}</h1><dl><dt>Cabinet ID</dt><dd>{detail.CabinetId:D}</dd><dt>Hostname</dt><dd>{WebUtility.HtmlEncode(detail.Hostname)}</dd><dt>Site</dt><dd>{WebUtility.HtmlEncode(detail.SiteName)}</dd><dt>Client</dt><dd>{WebUtility.HtmlEncode(detail.ClientName)}</dd></dl><a href=\"/\">Home</a></main></body></html>";
        return Results.Content(html, "text/html; charset=utf-8");
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException or NotSupportedException)
    {
        return Results.NotFound();
    }
});

app.MapPost("/login", async (HttpContext ctx, IAntiforgery antiforgery, IHttpClientFactory clients, DemoSessions sessions) =>
{
    if (!await ValidPost(ctx, antiforgery, origin)) return Results.BadRequest("Invalid request.");
    if (ctx.Request.ContentLength is > 4096) return Results.BadRequest("Invalid request.");
    try
    {
        var form = await ctx.Request.ReadFormAsync();
        var username = form["username"].ToString();
        var password = form["password"].ToString();
        if (username.Length is < 1 or > 128 || password.Length is < 1 or > 1024) return Results.Unauthorized();
        using var request = new HttpRequestMessage(HttpMethod.Post, "api/auth/login")
        {
            Content = JsonContent.Create(new { username, password })
        };
        using var response = await clients.CreateClient("server-login").SendAsync(request, HttpCompletionOption.ResponseContentRead, ctx.RequestAborted);
        if (response.StatusCode != HttpStatusCode.OK) return Results.Unauthorized();
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ctx.RequestAborted), cancellationToken: ctx.RequestAborted);
        var root = json.RootElement;
        if (!root.TryGetProperty("mustChangePassword", out var mustChange) || mustChange.ValueKind != JsonValueKind.False ||
            !root.TryGetProperty("role", out var role) || role.ValueKind != JsonValueKind.String ||
            role.GetString() is not ("Tier1" or "Tier2" or "Supervisor") ||
            !root.TryGetProperty("userId", out var userId) || !userId.TryGetGuid(out var id) || id == Guid.Empty)
            return Results.Unauthorized();
        var token = root.GetProperty("accessToken").GetString();
        var expiry = root.GetProperty("expiresAtUtc").GetDateTimeOffset();
        if (string.IsNullOrWhiteSpace(token) || expiry <= DateTimeOffset.UtcNow) return Results.Unauthorized();
        var key = sessions.Create(token, expiry);
        if (key is null) return Results.Unauthorized();
        ctx.Response.Cookies.Append("__Host-DemoSession", key, new CookieOptions
        {
            HttpOnly = true, Secure = true, SameSite = SameSiteMode.Strict, Path = "/",
            Expires = expiry < DateTimeOffset.UtcNow.AddMinutes(15) ? expiry : DateTimeOffset.UtcNow.AddMinutes(15)
        });
        return Results.Redirect("/", permanent: false, preserveMethod: false);
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or InvalidOperationException or InvalidDataException or FormatException)
    {
        return Results.Unauthorized();
    }
}).RequireRateLimiting("ingress");

app.MapPost("/logout", async (HttpContext ctx, IAntiforgery antiforgery, DemoSessions sessions) =>
{
    if (!await ValidPost(ctx, antiforgery, origin)) return Results.BadRequest("Invalid request.");
    if (ctx.Request.Cookies.TryGetValue("__Host-DemoSession", out var cookie)) sessions.Remove(cookie);
    ctx.Response.Cookies.Delete("__Host-DemoSession", new CookieOptions { Secure = true, HttpOnly = true, SameSite = SameSiteMode.Strict, Path = "/" });
    return Results.Redirect("/");
}).RequireRateLimiting("ingress");
app.Run();

static async Task<bool> ValidPost(HttpContext ctx, IAntiforgery antiforgery, Uri origin)
{
    if (!string.Equals(ctx.Request.Headers.Origin, origin.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal)) return false;
    if (!ctx.Request.HasFormContentType || ctx.Request.ContentLength is null or > 4096) return false;
    try { return await antiforgery.IsRequestValidAsync(ctx); }
    catch (AntiforgeryValidationException) { return false; }
}

static Uri RequireHttpsRoot(string? value)
{
    if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
        uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0 ||
        !string.IsNullOrEmpty(uri.UserInfo))
        throw new InvalidOperationException("DemoBff requires exact HTTPS PublicOrigin and ServerBaseUrl.");
    return uri;
}

static bool SafeLabel(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 256;

internal sealed record DemoCabinetDetail(Guid CabinetId, string? Hostname, string? FriendlyName, string? SiteName, string? ClientName);

public partial class Program;

namespace CabinetPlatform.DemoBff
{
    public sealed class DemoSessions
    {
        private readonly ConcurrentDictionary<string, Entry> _items = new();
        private readonly object _gate = new();
        private readonly TimeProvider _clock;
        public DemoSessions() : this(TimeProvider.System) { }
        public DemoSessions(TimeProvider clock) => _clock = clock;
        private sealed record Entry(string Token, DateTimeOffset Expires, DateTimeOffset LastSeen);
        private static string Digest(string key) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(key)));
        public string? Create(string token, DateTimeOffset upstreamExpiry)
        {
            lock (_gate)
            {
                var now = _clock.GetUtcNow();
                foreach (var pair in _items) if (pair.Value.Expires <= now || pair.Value.LastSeen.AddMinutes(10) <= now) _items.TryRemove(pair.Key, out _);
                if (_items.Count >= 1000) return null;
                var key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).Replace('+', '-').Replace('/', '_').TrimEnd('=');
                var expiry = upstreamExpiry < now.AddMinutes(15) ? upstreamExpiry : now.AddMinutes(15);
                _items[Digest(key)] = new Entry(token, expiry, now);
                return key;
            }
        }
        public bool Valid(string key) => TryGetToken(key, out _);
        public bool TryGetToken(string key, out string? token)
        {
            token = null;
            if (key.Length != 43) return false;
            var digest = Digest(key);
            lock (_gate)
            {
                if (!_items.TryGetValue(digest, out var entry)) return false;
                var now = _clock.GetUtcNow();
                if (now >= entry.Expires || now >= entry.LastSeen.AddMinutes(10))
                {
                    _items.TryRemove(digest, out _);
                    return false;
                }
                _items[digest] = entry with { LastSeen = now };
                token = entry.Token;
                return true;
            }
        }
        public void Remove(string key)
        {
            if (key.Length == 43) _items.TryRemove(Digest(key), out _);
        }
    }
}
