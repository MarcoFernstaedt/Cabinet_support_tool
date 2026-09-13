using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class RefreshRaceTests
{
    [Fact]
    public async Task Concurrent_expired_requests_exchange_one_rotating_refresh_token()
    {
        var session = SignedIn();
        var handler = new RefreshHandler();
        using var http = new HttpClient(new BearerTokenHandler(session) { InnerHandler = handler }) { BaseAddress = new Uri("https://console.test/") };
        var api = new ApiClient(http, session);
        var first = api.GetActionCatalogAsync(default);
        await handler.Started.Task;
        var second = api.GetActionCatalogAsync(default);
        handler.Release.SetResult();
        await Task.WhenAll(first, second);
        Assert.Equal(1, handler.Refreshes);
    }

    [Fact]
    public async Task Sign_out_during_refresh_cannot_restore_the_old_session()
    {
        var session = SignedIn();
        var handler = new RefreshHandler();
        using var http = new HttpClient(new BearerTokenHandler(session) { InnerHandler = handler }) { BaseAddress = new Uri("https://console.test/") };
        var api = new ApiClient(http, session);
        var request = api.GetActionCatalogAsync(default);
        await handler.Started.Task;
        session.SignOut();
        handler.Release.SetResult();
        try { await request; } catch (ApiException) { }
        Assert.False(session.IsSignedIn);
    }

    private static SessionStore SignedIn()
    {
        var session = new SessionStore();
        session.SignIn("old", DateTimeOffset.UtcNow, "refresh-old", "Test", Role.Tier2, false);
        return session;
    }

    private sealed class RefreshHandler : HttpMessageHandler
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Refreshes;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath == "/api/auth/refresh")
            {
                Interlocked.Increment(ref Refreshes);
                Started.TrySetResult();
                await Release.Task.WaitAsync(ct);
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new RefreshResponse { RefreshTokenExpiresAtUtc = DateTimeOffset.UtcNow.AddDays(1), UserId = Guid.NewGuid(), DisplayName = "Test", HasElevatedSql = false, AccessToken = "new", RefreshToken = "refresh-new", ExpiresAtUtc = DateTimeOffset.UtcNow.AddHours(1), Role = Role.Tier2, MustChangePassword = false }, options: ContractJson.Default) };
            }
            return request.Headers.Authorization?.Parameter == "new"
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("[]") }
                : new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("{}") };
        }
    }
}
