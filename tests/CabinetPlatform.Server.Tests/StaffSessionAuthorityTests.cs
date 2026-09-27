using System.Net;
using System.Net.Http.Headers;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Contracts.Audit;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace CabinetPlatform.Server.Tests;

public sealed class StaffSessionAuthorityTests
{
    [Fact]
    public async Task Overlapping_login_deactivation_and_reactivation_leave_only_current_authority()
    {
        using var factory = new SupportApiFactory();
        var (admin, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "race-admin");
        var (_, target) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "race-target");
        using var oldClient = factory.CreateClient();
        var old = (await (await oldClient.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = target.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        using var newClient = factory.CreateClient();
        Task<HttpResponseMessage> login = newClient.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = "RACE-TARGET", Password = "Str0ng!TestPassword" });
        Task<HttpResponseMessage> disable = admin.PatchJsonAsync($"/api/users/{target.Id}",
            new UpdateUserRequest { IsActive = false, SupportAccountsOnly = true });
        Task<HttpResponseMessage> reactivate = admin.PatchJsonAsync($"/api/users/{target.Id}",
            new UpdateUserRequest { IsActive = true, SupportAccountsOnly = true });
        var responses = await Task.WhenAll(login, disable, reactivate);
        Assert.All(responses, response => Assert.True(response.StatusCode is HttpStatusCode.OK or
            HttpStatusCode.Forbidden or HttpStatusCode.Conflict, response.StatusCode.ToString()));
        oldClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", old.AccessToken);
        Assert.Equal(HttpStatusCode.Unauthorized, (await oldClient.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await oldClient.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = old.RefreshToken })).StatusCode);
        if (responses[0].StatusCode == HttpStatusCode.OK)
        {
            var candidate = (await responses[0].ReadAsync<LoginResponse>())!;
            newClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", candidate.AccessToken);
            var current = await factory.WithDbAsync(db => db.Users.AsNoTracking()
                .Where(u => u.Id == target.Id).Select(u => u.IsActive).SingleAsync());
            var access = await newClient.GetAsync("/api/auth/me");
            if (!current) Assert.Equal(HttpStatusCode.Unauthorized, access.StatusCode);
            if (access.StatusCode == HttpStatusCode.Unauthorized)
                Assert.Equal(HttpStatusCode.Forbidden, (await newClient.PostJsonAsync("/api/auth/refresh",
                    new RefreshRequest { RefreshToken = candidate.RefreshToken })).StatusCode);
        }
    }

    [Fact]
    public async Task Database_rejects_case_equivalent_username_even_when_creation_bypasses_controller()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "UniqueCase");
        var (_, other) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "differentCase");
        await factory.WithDbAsync(async db =>
        {
            // The index is the last guard against concurrent creates.
            var conflict = await Assert.ThrowsAsync<SqliteException>(() => db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE Users SET Username = {"uNIQUEcASE"} WHERE Id = {other.Id}"));
            Assert.Equal(19, conflict.SqliteErrorCode);
            Assert.Equal(user.Id, (await db.Users.AsNoTracking().SingleAsync(u => u.Username == "UniqueCase")).Id);
        });
    }
    [Fact]
    public async Task Mixed_case_login_preserves_password_case_and_refuses_duplicate_and_inactive_account()
    {
        using var factory = new SupportApiFactory();
        var (admin, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "case-admin");
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "CaseSupport");
        using var browser = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = "cASEsUPPORT", Password = "str0ng!TestPassword" })).StatusCode);
        var login = (await (await browser.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = "cASEsUPPORT", Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        Assert.Equal(user.Id, login.UserId);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostJsonAsync("/api/users", new CreateUserRequest
        { Username = "casesupport", DisplayName = "Duplicate", Role = Role.Tier1,
            InitialPassword = "Temporary!Password42" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PatchJsonAsync($"/api/users/{user.Id}",
            new UpdateUserRequest { IsActive = false, SupportAccountsOnly = true })).StatusCode);
        browser.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = login.RefreshToken })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = "cASEsUPPORT", Password = "Str0ng!TestPassword" })).StatusCode);
    }

    [Fact]
    public async Task Reactivation_requires_fresh_login_and_never_resurrects_old_tokens()
    {
        using var factory = new SupportApiFactory();
        var (admin, supervisor) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "react-admin");
        var (nonSupervisor, _) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "react-other");
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "react-target", mustChangePassword: true);
        using var browser = factory.CreateClient();
        var login = (await (await browser.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        Assert.Equal(HttpStatusCode.OK, (await admin.PatchJsonAsync($"/api/users/{user.Id}",
            new UpdateUserRequest { IsActive = false, SupportAccountsOnly = true })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await nonSupervisor.PatchJsonAsync($"/api/users/{user.Id}",
            new UpdateUserRequest { IsActive = true, SupportAccountsOnly = true })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PatchJsonAsync($"/api/users/{user.Id}",
            new UpdateUserRequest { IsActive = true, SupportAccountsOnly = true })).StatusCode);
        var reactivation = await factory.WithDbAsync(db => db.AuditEntries.AsNoTracking()
            .Where(a => a.Event == AuditEvent.UpdateUser && a.ActorId == supervisor.Id.ToString())
            .ToListAsync());
        Assert.Contains(reactivation, a => a.Result == AuditResult.Success && a.Details != null &&
            JsonDocument.Parse(a.Details).RootElement.EnumerateObject()
                .Where(p => p.Name.Equals("changes", StringComparison.OrdinalIgnoreCase))
                .SelectMany(p => p.Value.EnumerateArray())
                .Any(change => change.GetString() == "IsActive False -> True"));
        browser.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = login.RefreshToken })).StatusCode);
        var fresh = (await (await browser.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = "REACT-TARGET", Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        Assert.True(fresh.MustChangePassword);
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = login.RefreshToken })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PatchJsonAsync($"/api/users/{user.Id}",
            new UpdateUserRequest { IsActive = true, SupportAccountsOnly = true })).StatusCode);
        browser.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", fresh.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/auth/me")).StatusCode);
    }
    [Fact]
    public async Task Login_wins_over_in_flight_old_refresh_without_resurrecting_it()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "racing-place");
        using var first = factory.CreateClient();
        using var second = factory.CreateClient();
        LoginResponse old = (await (await first.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var scope = factory.Services.CreateScope();
        var services = scope.ServiceProvider;
        var refresh = new RefreshTokenService(services.GetRequiredService<SupportDbContext>(),
            new PausedJwt(services.GetRequiredService<IJwtTokenService>(), entered, release),
            services.GetRequiredService<IAuditService>(), services.GetRequiredService<IOptions<JwtOptions>>(),
            services.GetRequiredService<TimeProvider>(), services.GetRequiredService<ILogger<RefreshTokenService>>());
        Task<OperationResult<RefreshResponse>> rotating = Task.Run(() => refresh.RefreshAsync(old.RefreshToken, default));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        LoginResponse newest = (await (await second.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        release.SetResult();
        Assert.False((await rotating).Succeeded);
        second.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", newest.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await second.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await second.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = newest.RefreshToken })).StatusCode);
    }

    private sealed class PausedJwt(IJwtTokenService inner, TaskCompletionSource entered,
        TaskCompletionSource release) : IJwtTokenService
    {
        public IssuedToken Issue(User user)
        {
            entered.TrySetResult();
            release.Task.Wait(TimeSpan.FromSeconds(10));
            return inner.Issue(user);
        }
        public TokenValidationParameters BuildValidationParameters() => inner.BuildValidationParameters();
    }

    [Fact]
    public async Task Replaying_consumed_previous_family_cannot_evict_newest_login()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "replay-place");
        using var oldClient = factory.CreateClient();
        LoginResponse old = (await (await oldClient.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        Assert.Equal(HttpStatusCode.OK, (await oldClient.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = old.RefreshToken })).StatusCode);
        using var newestClient = factory.CreateClient();
        LoginResponse newest = (await (await newestClient.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        Assert.Equal(HttpStatusCode.Forbidden, (await oldClient.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = old.RefreshToken })).StatusCode);
        newestClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", newest.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await newestClient.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await newestClient.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = newest.RefreshToken })).StatusCode);
    }

    [Fact]
    public async Task Concurrent_logins_never_leave_two_usable_sessions()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "parallel-place");
        using var a = factory.CreateClient();
        using var b = factory.CreateClient();
        Task<HttpResponseMessage> first = a.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" });
        Task<HttpResponseMessage> second = b.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" });
        HttpResponseMessage[] results = await Task.WhenAll(first, second);
        var successful = new List<LoginResponse>();
        foreach (HttpResponseMessage response in results)
        {
            Assert.True(response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Forbidden);
            if (response.StatusCode == HttpStatusCode.OK)
                successful.Add((await response.ReadAsync<LoginResponse>())!);
        }
        Assert.NotEmpty(successful);
        int valid = 0;
        foreach (LoginResponse login in successful)
        {
            using var client = factory.CreateClient();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);
            if ((await client.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK) valid++;
        }
        Assert.Equal(1, valid);
    }

    [Fact]
    public async Task First_password_change_requires_fresh_login_and_preserves_new_session()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "forced-place",
            mustChangePassword: true);
        using var client = factory.CreateClient();
        LoginResponse initial = (await (await client.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        Assert.True(initial.MustChangePassword);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", initial.AccessToken);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync("/api/auth/change-password",
            new ChangePasswordRequest { CurrentPassword = "Str0ng!TestPassword",
                NewPassword = "Different!Password123" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = initial.RefreshToken })).StatusCode);
        using var next = factory.CreateClient();
        LoginResponse fresh = (await (await next.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Different!Password123" })).ReadAsync<LoginResponse>())!;
        Assert.False(fresh.MustChangePassword);
        next.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", fresh.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await next.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Promotion_ends_existing_access_and_refresh_authority()
    {
        using var factory = new SupportApiFactory();
        var (supervisor, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "staff-promoter");
        var (_, target) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "staff-promoted");
        using var browser = factory.CreateClient();
        LoginResponse login = (await (await browser.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = target.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        browser.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/auth/me")).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await supervisor.PatchJsonAsync($"/api/users/{target.Id}",
            new { Role = Role.Tier2 })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/auth/me")).StatusCode);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Forbidden, (await anonymous.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = login.RefreshToken })).StatusCode);
    }

    [Fact]
    public async Task New_successful_login_replaces_old_session_but_bad_password_does_not()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "single-place");
        var (_, other) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "different-place");
        using var first = factory.CreateClient();
        using var second = factory.CreateClient();
        using var peer = factory.CreateClient();
        LoginResponse old = (await (await first.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        LoginResponse independent = (await (await peer.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = other.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        first.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", old.AccessToken);
        peer.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", independent.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await second.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "wrong-password" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await first.GetAsync("/api/auth/me")).StatusCode);
        LoginResponse newest = (await (await second.PostJsonAsync("/api/auth/login", new LoginRequest
        { Username = user.Username, Password = "Str0ng!TestPassword" })).ReadAsync<LoginResponse>())!;
        second.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", newest.AccessToken);
        Assert.Equal(HttpStatusCode.Unauthorized, (await first.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await first.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = old.RefreshToken })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await second.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await peer.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await second.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = newest.RefreshToken })).StatusCode);
    }
}
