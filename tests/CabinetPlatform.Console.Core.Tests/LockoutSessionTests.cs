using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Console.Core.Api;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class LockoutSessionTests
{
    [Fact]
    public async Task Existing_console_refreshes_expired_bearer_despite_password_login_lockout()
    {
        using var host = new ConsoleTestHost();
        var user = await host.CreateUserAsync(Role.Tier1, "lockout-console");
        var (api, session) = host.CreateConsole();
        using (api)
        {
            var login = await api.LoginAsync(new LoginRequest
            {
                Username = user.Username, Password = ConsoleTestHost.KnownPassword
            }, default);
            session.SignIn("expired-bearer", DateTimeOffset.UtcNow.AddMinutes(-1),
                login.RefreshToken, login.DisplayName, login.Role, login.MustChangePassword);
            session.AttachIdentity(login.UserId, user.Username, login.Role, login.MustChangePassword);
            var threshold = host.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<
                CabinetPlatform.Server.Configuration.LoginSecurityOptions>>().Value.MaxFailedAttempts;
            using var attacker = host.CreateClient();
            for (int i = 0; i < threshold; i++)
            {
                var denied = await attacker.PostAsJsonAsync("/api/auth/login", new LoginRequest
                {
                    Username = user.Username, Password = "incorrect"
                });
                Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            }
            Assert.Equal(user.Id, (await api.GetCurrentUserAsync(default)).Id);
            Assert.True(session.IsSignedIn);
            Assert.NotEqual("expired-bearer", session.AccessToken);
            Assert.NotEqual(login.RefreshToken, session.RefreshToken);
            Assert.Equal(user.Id, (await api.GetCurrentUserAsync(default)).Id);
        }
    }
}
