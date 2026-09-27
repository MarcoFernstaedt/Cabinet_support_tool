using System.Net;
using CabinetPlatform.Contracts.Auth;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using CabinetPlatform.Server.Services;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Auditing;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging;
using CabinetPlatform.Server.Domain;
using Microsoft.IdentityModel.Tokens;

namespace CabinetPlatform.Server.Tests;

public sealed class SessionSafetyTests
{
    [Fact]
    public async Task Overlapping_refreshes_cannot_both_mint_a_successor()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "overlap");
        using var client = factory.CreateClient();
        var login = await (await client.PostJsonAsync("/api/auth/login", new LoginRequest
        {
            Username = user.Username, Password = "Str0ng!TestPassword"
        })).ReadAsync<LoginResponse>();
        Assert.NotNull(login);
        using var barrier = new Barrier(2);
        async Task<OperationResult<RefreshResponse>> Rotate()
        {
            using var scope = factory.Services.CreateScope();
            var sp = scope.ServiceProvider;
            var service = new RefreshTokenService(sp.GetRequiredService<SupportDbContext>(),
                new GatedTokens(sp.GetRequiredService<IJwtTokenService>(), barrier),
                sp.GetRequiredService<IAuditService>(), sp.GetRequiredService<IOptions<JwtOptions>>(),
                sp.GetRequiredService<TimeProvider>(), sp.GetRequiredService<ILogger<RefreshTokenService>>());
            return await service.RefreshAsync(login.RefreshToken, default);
        }
        var outcomes = await Task.WhenAll(Task.Run(Rotate), Task.Run(Rotate));
        Assert.Single(outcomes, r => r.Succeeded);
        var winner = outcomes.Single(r => r.Succeeded).Value!;
        var replay = await client.PostJsonAsync("/api/auth/refresh", new RefreshRequest { RefreshToken = winner.RefreshToken });
        Assert.Equal(HttpStatusCode.Forbidden, replay.StatusCode);
    }

    private sealed class GatedTokens(IJwtTokenService inner, Barrier barrier) : IJwtTokenService
    {
        public IssuedToken Issue(User user)
        {
            if (!barrier.SignalAndWait(TimeSpan.FromSeconds(15)))
                throw new TimeoutException("Both refreshes must reach issuance before either saves.");
            return inner.Issue(user);
        }
        public TokenValidationParameters BuildValidationParameters() => inner.BuildValidationParameters();
    }

    [Theory]
    [InlineData("deactivate")]
    [InlineData("demote")]
    [InlineData("revoke")]
    [InlineData("password")]
    public async Task Security_changes_immediately_reject_existing_access_tokens(string change)
    {
        using var factory = new SupportApiFactory();
        var (admin, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "admin");
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "target");
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/auth/me")).StatusCode);
        HttpResponseMessage result = change switch
        {
            "deactivate" => await admin.PatchJsonAsync($"/api/users/{user.Id}", new { IsActive = false }),
            "demote" => await admin.PatchJsonAsync($"/api/users/{user.Id}", new { Role = Role.Tier1 }),
            "revoke" => await admin.PostJsonAsync($"/api/users/{user.Id}/revoke-sessions", new { Reason = "Contain session", TicketReference = "SEC-1" }),
            _ => await client.PostJsonAsync("/api/auth/change-password", new ChangePasswordRequest
            {
                CurrentPassword = "Str0ng!TestPassword", NewPassword = "Different!Password123"
            })
        };
        Assert.True(result.IsSuccessStatusCode, await result.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Password_change_revokes_existing_refresh_sessions()
    {
        using var factory = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "password-session");
        using var anonymous = factory.CreateClient();
        var login = await (await anonymous.PostJsonAsync("/api/auth/login", new LoginRequest
        {
            Username = user.Username, Password = "Str0ng!TestPassword"
        })).ReadAsync<LoginResponse>();
        Assert.NotNull(login);
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", login.AccessToken);
        var changed = await client.PostJsonAsync("/api/auth/change-password", new ChangePasswordRequest
        {
            CurrentPassword = "Str0ng!TestPassword", NewPassword = "Different!Password123"
        });
        Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
        var refresh = await anonymous.PostJsonAsync("/api/auth/refresh", new RefreshRequest { RefreshToken = login.RefreshToken });
        Assert.Equal(HttpStatusCode.Forbidden, refresh.StatusCode);
    }

    [Fact]
    public async Task Rotation_does_not_extend_the_absolute_session_expiry()
    {
        using var factory = new SupportApiFactory();
        var (_, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "absolute-session");
        using var client = factory.CreateClient();
        var login = await (await client.PostJsonAsync("/api/auth/login", new LoginRequest
        {
            Username = user.Username, Password = "Str0ng!TestPassword"
        })).ReadAsync<LoginResponse>();
        Assert.NotNull(login);
        var expiry = DateTimeOffset.UtcNow.AddMinutes(10);
        await factory.WithDbAsync(async db =>
        {
            var token = await db.RefreshTokens.SingleAsync(t => t.UserId == user.Id);
            token.ExpiresUtc = expiry;
            await db.SaveChangesAsync();
        });
        var refreshed = await (await client.PostJsonAsync("/api/auth/refresh", new RefreshRequest { RefreshToken = login.RefreshToken })).ReadAsync<RefreshResponse>();
        Assert.NotNull(refreshed);
        Assert.Equal(expiry, refreshed.RefreshTokenExpiresAtUtc);
    }
}
