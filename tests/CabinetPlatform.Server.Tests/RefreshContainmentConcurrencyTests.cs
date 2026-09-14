using System.Net;
using System.Data.Common;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection.Extensions;
using System.Net.Http.Headers;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Server.Tests;

public sealed class RefreshContainmentConcurrencyTests
{
    [Theory]
    [InlineData("rotation")]
    [InlineData("replay")]
    [InlineData("password")]
    public async Task Containment_retries_a_competing_commit_without_harming_recovery(string competitor)
    {
        using var baseFactory = new SupportApiFactory();
        var pause = new PauseFirstContainment();
        using var factory = baseFactory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            services.AddDbContext<SqliteSupportDbContext>((sp, options) => options
                .UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString).AddInterceptors(pause));
        }));
        using var client = factory.CreateClient();
        var login = await LoginAsync(client, SupportApiFactory.SeedSupervisorPassword);
        var firstRotation = await (await RefreshAsync(client, login.RefreshToken)).ReadAsync<RefreshResponse>();
        Assert.NotNull(firstRotation);
        pause.Armed = true;
        Task<HttpResponseMessage> containment = RefreshAsync(client, login.RefreshToken);
        await pause.Reached.Task.WaitAsync(TimeSpan.FromSeconds(15));
        RefreshResponse? winner = null;
        LoginResponse? recovered = null;
        try
        {
            using var competing = factory.CreateClient();
            if (competitor == "rotation")
            {
                var response = await RefreshAsync(competing, firstRotation.RefreshToken);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                winner = await response.ReadAsync<RefreshResponse>();
                Assert.NotNull(winner);
            }
            else
            {
                string password = SupportApiFactory.SeedSupervisorPassword;
                if (competitor == "password")
                {
                    competing.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", firstRotation.AccessToken);
                    password = "Different!Password123";
                    Assert.Equal(HttpStatusCode.NoContent, (await competing.PostJsonAsync("/api/auth/change-password",
                        new ChangePasswordRequest { CurrentPassword = SupportApiFactory.SeedSupervisorPassword, NewPassword = password })).StatusCode);
                    competing.DefaultRequestHeaders.Authorization = null;
                }
                else
                {
                    Assert.Equal(HttpStatusCode.Forbidden, (await RefreshAsync(competing, login.RefreshToken)).StatusCode);
                }
                recovered = await LoginAsync(competing, password);
            }
        }
        finally
        {
            pause.Release.TrySetResult();
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await containment).StatusCode);

        using var check = factory.CreateClient();
        if (winner is not null)
        {
            check.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", winner.AccessToken);
            Assert.Equal(HttpStatusCode.Unauthorized, (await check.GetAsync("/api/auth/me")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await RefreshAsync(client, winner.RefreshToken)).StatusCode);
        }
        else
        {
            Assert.NotNull(recovered);
            check.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", recovered.AccessToken);
            Assert.Equal(HttpStatusCode.OK, (await check.GetAsync("/api/auth/me")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await RefreshAsync(client, recovered.RefreshToken)).StatusCode);
        }
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        byte[] hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(login.RefreshToken));
        Guid chainId = (await db.RefreshTokens.SingleAsync(t => t.TokenHash == hash)).ChainId;
        Assert.All(await db.RefreshTokens.Where(t => t.ChainId == chainId).ToListAsync(), t => Assert.NotNull(t.RevokedUtc));
    }

    private static Task<HttpResponseMessage> RefreshAsync(HttpClient client, string token) =>
        client.PostJsonAsync("/api/auth/refresh", new RefreshRequest { RefreshToken = token });

    private static async Task<LoginResponse> LoginAsync(HttpClient client, string password)
    {
        var response = await client.PostJsonAsync("/api/auth/login", new LoginRequest
        {
            Username = SupportApiFactory.SeedSupervisorUsername, Password = password
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.ReadAsync<LoginResponse>();
        Assert.NotNull(result);
        return result;
    }

    private sealed class PauseFirstContainment : SaveChangesInterceptor
    {
        public bool Armed { get; set; }
        private int _paused;
        public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Armed && eventData.Context!.ChangeTracker.Entries<RefreshToken>()
                    .Any(e => e.State == EntityState.Modified && e.Entity.RevokedUtc is not null)
                && Interlocked.CompareExchange(ref _paused, 1, 0) == 0)
            {
                Reached.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken);
            }
            return result;
        }
    }
}
