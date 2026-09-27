using System.Net;
using System.Net.Http.Headers;
using CabinetPlatform.Contracts.Auth;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class SafetyReviewStaleReplayTests
{
    [Theory]
    [InlineData("password")]
    [InlineData("containment")]
    [InlineData("expiry")]
    public async Task Historical_replay_must_not_end_a_new_session(string endedBy)
    {
        using var factory = new SupportApiFactory();
        var (original, user) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "review-replay");
        using var anonymous = factory.CreateClient();
        const string oldPassword = "Str0ng!TestPassword";
        const string newPassword = "Different!Password123";
        var oldLogin = await LoginAsync(anonymous, user.Username, oldPassword);
        var rotatedResponse = await anonymous.PostJsonAsync("/api/auth/refresh",
            new RefreshRequest { RefreshToken = oldLogin.RefreshToken });
        Assert.Equal(HttpStatusCode.OK, rotatedResponse.StatusCode);
        var rotated = await rotatedResponse.ReadAsync<RefreshResponse>();
        Assert.NotNull(rotated);
        original.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", rotated.AccessToken);

        switch (endedBy)
        {
            case "password":
                var changed = await original.PostJsonAsync("/api/auth/change-password", new ChangePasswordRequest
                {
                    CurrentPassword = oldPassword, NewPassword = newPassword
                });
                Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
                break;
            case "containment":
                Assert.Equal(HttpStatusCode.Forbidden, (await ReplayAsync(anonymous, oldLogin.RefreshToken)).StatusCode);
                break;
            case "expiry":
                await factory.WithDbAsync(async db =>
                {
                    foreach (var token in await db.RefreshTokens.Where(t => t.UserId == user.Id).ToListAsync())
                        token.ExpiresUtc = DateTimeOffset.UtcNow.AddHours(-1);
                    await db.SaveChangesAsync();
                });
                break;
        }

        if (endedBy != "expiry")
        {
            using var oldAccess = factory.CreateClient();
            oldAccess.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", rotated.AccessToken);
            Assert.Equal(HttpStatusCode.Unauthorized, (await oldAccess.GetAsync("/api/auth/me")).StatusCode);
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await ReplayAsync(anonymous, rotated.RefreshToken)).StatusCode);

        var fresh = await LoginAsync(anonymous, user.Username, endedBy == "password" ? newPassword : oldPassword);
        using var legitimate = factory.CreateClient();
        legitimate.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", fresh.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await legitimate.GetAsync("/api/auth/me")).StatusCode);

        Guid stamp = default;
        await factory.WithDbAsync(async db => stamp = (await db.Users.SingleAsync(u => u.Id == user.Id)).SecurityStamp);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await ReplayAsync(anonymous, oldLogin.RefreshToken)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await legitimate.GetAsync("/api/auth/me")).StatusCode);
            await factory.WithDbAsync(async db =>
                Assert.Equal(stamp, (await db.Users.SingleAsync(u => u.Id == user.Id)).SecurityStamp));
        }
        // Historical denial must preserve the unrelated family's ability to rotate.
        Assert.Equal(HttpStatusCode.OK, (await ReplayAsync(anonymous, fresh.RefreshToken)).StatusCode);
    }

    private static Task<HttpResponseMessage> ReplayAsync(HttpClient client, string token) =>
        client.PostJsonAsync("/api/auth/refresh", new RefreshRequest { RefreshToken = token });

    private static async Task<LoginResponse> LoginAsync(HttpClient client, string username, string password)
    {
        var response = await client.PostJsonAsync("/api/auth/login", new LoginRequest
        {
            Username = username, Password = password
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var login = await response.ReadAsync<LoginResponse>();
        Assert.NotNull(login);
        return login;
    }
}
