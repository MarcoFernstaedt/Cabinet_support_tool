using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class SessionIsolationTests
{
    [Fact]
    public async Task Deactivated_load_cannot_return_a_late_value()
    {
        var screen = new ProbeScreen();
        var completion = new TaskCompletionSource<string>();
        Task<string?> loading = screen.LoadAsync(completion.Task);
        screen.Deactivate();
        Assert.True(screen.Token.IsCancellationRequested);
        completion.SetResult("previous operator data");
        Assert.Null(await loading);
    }

    [Fact]
    public async Task Disposing_the_session_client_cancels_unscoped_work_and_refuses_future_requests()
    {
        var handler = new HeldHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://synthetic.invalid/") };
        var api = new ApiClient(http, new SessionStore());
        Task loading = api.GetCurrentUserAsync(CancellationToken.None);
        Assert.IsAssignableFrom<IDisposable>(api).Dispose();
        Assert.True(handler.Token.IsCancellationRequested);
        handler.Completion.SetResult(new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => loading);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => api.GetCurrentUserAsync(CancellationToken.None));
        Assert.Equal(1, handler.Requests);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Retiring_during_startup_stops_the_remaining_load_chain(bool expiry)
    {
        var handler = new HeldHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://synthetic.invalid/") };
        using var api = new ApiClient(http, new SessionStore());
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddHours(1), "synthetic", "Operator", CabinetPlatform.Contracts.Auth.Role.Supervisor, false);
        var shell = CreateShell(api, session);
        var reasons = new List<CabinetPlatform.Console.Core.ViewModels.SignInReason>();
        shell.SignInRequired += (_, reason) => reasons.Add(reason);
        Task loading = shell.StartSessionAsync();
        if (!expiry) shell.SignOutCommand.Execute(null);
        handler.Completion.SetResult(new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized));
        await loading;
        Assert.Single(reasons);
        Assert.Equal(expiry ? CabinetPlatform.Console.Core.ViewModels.SignInReason.SessionExpired
            : CabinetPlatform.Console.Core.ViewModels.SignInReason.SignedOut, reasons[0]);
        Assert.Equal(1, handler.Requests);
        Assert.Empty(shell.Cabinets.Cabinets);
        Assert.Null(shell.Fleet.Summary);
    }

    [Fact]
    public async Task Idle_check_retires_shell_on_server_denial_without_fleet_polling()
    {
        var handler = new HeldHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://synthetic.invalid/") };
        var session = new SessionStore();
        session.SignIn("old-token", DateTimeOffset.UtcNow.AddHours(1), "old-refresh",
            "Operator", Role.Tier1, false);
        using var api = new ApiClient(http, session);
        var shell = CreateShell(api, session);
        var reasons = new List<SignInReason>();
        shell.SignInRequired += (_, reason) => reasons.Add(reason);
        Task startup = shell.StartSessionAsync();
        await shell.CheckSessionAsync(CancellationToken.None);
        Assert.Equal(new[] { SignInReason.SessionExpired }, reasons);
        Assert.False(session.IsSignedIn);
        handler.Completion.SetResult(new HttpResponseMessage(HttpStatusCode.OK));
        await startup;
        await shell.CheckSessionAsync(CancellationToken.None);
        Assert.Single(reasons);
        Assert.Equal(3, handler.Requests);
    }

    [Fact]
    public async Task Idle_check_keeps_shell_when_server_is_unreachable()
    {
        var handler = new UnreachableSessionHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://synthetic.invalid/") };
        var session = new SessionStore();
        session.SignIn("old-token", DateTimeOffset.UtcNow.AddHours(1), "old-refresh",
            "Operator", Role.Tier1, false);
        using var api = new ApiClient(http, session);
        var shell = CreateShell(api, session);
        var reasons = new List<SignInReason>();
        shell.SignInRequired += (_, reason) => reasons.Add(reason);
        Task startup = shell.StartSessionAsync();
        await shell.CheckSessionAsync(CancellationToken.None);
        Assert.Empty(reasons);
        Assert.True(session.IsSignedIn);
        shell.SignOutCommand.Execute(null);
        handler.Completion.SetResult(new HttpResponseMessage(HttpStatusCode.OK));
        await startup;
    }

    private sealed class UnreachableSessionHandler : HttpMessageHandler
    {
        private int _requests;
        public TaskCompletionSource<HttpResponseMessage> Completion { get; } = new();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Interlocked.Increment(ref _requests) == 1 ? Completion.Task :
                Task.FromException<HttpResponseMessage>(new HttpRequestException("offline"));
    }

    internal static CabinetPlatform.Console.Core.ViewModels.ShellViewModel CreateShell(IApiClient api, SessionStore session)
    {
        var announcer = NullLiveRegionAnnouncer.Instance;
        var time = TimeProvider.System;
        return new(
            new(api, announcer, time), new(api, announcer, time),
            new(api, new ActionInvoker(api, ScriptedActionDialog.Accepting(), announcer, session), session, announcer, time),
            new(), new(api, announcer, time), new(api, announcer, time),
            new(api, ScriptedApprovalDialog.Accepting(), session, announcer, time),
            new(api, session, announcer), session, announcer, api, new(api, session, announcer));
    }

    private sealed class HeldHandler : HttpMessageHandler
    {
        public CancellationToken Token { get; private set; }
        public int Requests { get; private set; }
        public TaskCompletionSource<HttpResponseMessage> Completion { get; } = new();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests++;
            Token = ct;
            return Requests == 1 ? Completion.Task : Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Deactivated_load_cannot_report_late_success_or_failure(bool failure)
    {
        var screen = new ProbeScreen();
        var completion = new TaskCompletionSource();
        Task<bool> loading = screen.LoadVoidAsync(completion.Task);
        screen.Deactivate();
        if (failure) completion.SetException(new ApiException(ApiFailure.SessionExpired, "old session"));
        else completion.SetResult();
        Assert.False(await loading);
        Assert.Null(screen.ErrorMessage);
        Assert.False(screen.RequiresReauthentication);
    }

    [Fact]
    public async Task Disposing_during_smart_history_cancels_without_faulting_the_retired_shell()
    {
        var handler = new HeldHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://synthetic.invalid/") };
        var session = new SessionStore();
        using var api = new ApiClient(http, session);
        var shell = CreateShell(api, session);
        shell.Machine.CabinetId = Guid.NewGuid();
        shell.Machine.Disk.HistoryDays++;
        Task loading = shell.Machine.PendingHistoryLoad;
        Assert.Equal(1, handler.Requests);
        shell.Dispose();
        api.Dispose();
        handler.Completion.SetResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK));
        await loading;
        Assert.Null(shell.Machine.CabinetId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancelled_login_exit_cancels_body_and_late_success_cannot_sign_in(bool duringIdentity)
    {
        var response = new LoginResponse
        {
            AccessToken = "synthetic-old-token", RefreshToken = "synthetic-old-refresh",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddHours(1), RefreshTokenExpiresAtUtc = DateTimeOffset.UtcNow.AddDays(1),
            UserId = Guid.NewGuid(), DisplayName = "Previous operator", Role = Role.Supervisor,
            HasElevatedSql = false, MustChangePassword = false
        };
        var identity = new UserDto
        {
            Id = response.UserId, Username = "synthetic-old", DisplayName = response.DisplayName,
            Role = response.Role, HasElevatedSql = false, HasHardwareActuation = false,
            IsActive = true, MustChangePassword = false, CreatedUtc = DateTimeOffset.UtcNow, IsLockedOut = false
        };
        byte[] body = duringIdentity ? JsonSerializer.SerializeToUtf8Bytes(identity, ContractJson.CreateOptions())
            : JsonSerializer.SerializeToUtf8Bytes(response, ContractJson.CreateOptions());
        using var stream = new HeldBody(body);
        using var http = new HttpClient(new LoginBodyHandler(response, stream, duringIdentity))
            { BaseAddress = new Uri("https://synthetic.invalid/") };
        var session = new SessionStore();
        using var api = new ApiClient(http, session);
        var login = new LoginViewModel(api, session, NullLiveRegionAnnouncer.Instance)
            { Username = "synthetic-old", Password = "synthetic-password" };
        int signedIn = 0;
        login.SignedIn += (_, _) => signedIn++;
        Task loading = login.SignInCommand.ExecuteAsync(null);
        await stream.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (duringIdentity) Assert.True(session.IsSignedIn);

        // The login-close and provider-disposal path used by App.
        login.Deactivate();
        login.ClearSecrets();
        api.Dispose();
        Assert.True(stream.Token.IsCancellationRequested);
        Assert.False(session.IsSignedIn);
        var next = new SessionStore();
        next.SignIn("synthetic-next", DateTimeOffset.UtcNow.AddHours(1), "synthetic-next-refresh", "Next operator", Role.Tier1, false);
        stream.Release.SetResult(); // Body ignores cancellation and still returns valid old data.
        await loading;
        Assert.Equal(0, signedIn);
        Assert.False(session.IsSignedIn);
        Assert.Null(session.UserId);
        Assert.Equal("", login.Password);
        Assert.Equal("synthetic-next", next.AccessToken);
        Assert.Equal(Role.Tier1, next.Role);
    }

    private sealed class LoginBodyHandler(LoginResponse login, Stream body, bool duringIdentity) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = duringIdentity && request.RequestUri!.AbsolutePath.EndsWith("/login")
                    ? JsonContent.Create(login, options: ContractJson.CreateOptions()) : new StreamContent(body)
            });
    }

    private sealed class HeldBody(byte[] bytes) : MemoryStream(bytes)
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public CancellationToken Token { get; private set; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Token = cancellationToken;
            Entered.TrySetResult();
            await Release.Task;
            return await base.ReadAsync(buffer, CancellationToken.None);
        }
    }

    private sealed class ProbeScreen() : ObservableViewModelBase(NullLiveRegionAnnouncer.Instance)
    {
        public CancellationToken Token { get; private set; }
        public Task<bool> LoadVoidAsync(Task response) => RunAsync(ct => { Token = ct; return response; });
        public Task<string?> LoadAsync(Task<string> response) => RunAsync(ct =>
        {
            Token = ct;
            return response; // Deliberately ignores cancellation, like a racing completion.
        });
    }
}
