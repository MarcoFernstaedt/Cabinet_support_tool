using Mashura.CabinetSupport.Console.Core.Api;
using Mashura.CabinetSupport.Console.Core.Presentation;
using Mashura.CabinetSupport.Console.Core.ViewModels;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Console.Core.Tests;

/// <summary>
/// Sign-in against the real server, including the three refusals the brief
/// requires the user to be able to tell apart.
/// </summary>
public sealed class SignInTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;

    public SignInTests(ConsoleTestHost host) => _host = host;

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];

    private (LoginViewModel Login, SessionStore Session, RecordingLiveRegionAnnouncer Announcer)
        CreateLogin()
    {
        (ApiClient api, SessionStore session) = _host.CreateConsole();
        RecordingLiveRegionAnnouncer announcer = new();

        return (new LoginViewModel(api, session, announcer), session, announcer);
    }

    [Fact]
    public async Task Correct_credentials_sign_in_and_populate_the_session()
    {
        string username = Unique("t2");
        await _host.CreateUserAsync(UserRole.Tier2, username);

        (LoginViewModel login, SessionStore session, RecordingLiveRegionAnnouncer announcer) =
            CreateLogin();

        login.Username = username;
        login.Password = ConsoleTestHost.KnownPassword;

        await login.SignInCommand.ExecuteAsync(null);

        Assert.Null(login.ErrorMessage);
        Assert.Equal(SignInProblem.None, login.Problem);
        Assert.True(session.IsSignedIn);
        Assert.Equal(UserRole.Tier2, session.Role);

        // The user id only arrives via /api/auth/me, and the Approvals view
        // needs it to recognise the user's own requests.
        Assert.NotNull(session.UserId);

        Assert.True(announcer.Any("Signed in"));
    }

    [Fact]
    public async Task Password_is_cleared_from_memory_after_a_successful_sign_in()
    {
        string username = Unique("clear");
        await _host.CreateUserAsync(UserRole.Tier1, username);

        (LoginViewModel login, _, _) = CreateLogin();

        login.Username = username;
        login.Password = ConsoleTestHost.KnownPassword;

        await login.SignInCommand.ExecuteAsync(null);

        Assert.Equal(string.Empty, login.Password);
    }

    [Fact]
    public async Task A_wrong_password_is_reported_as_a_credential_problem_and_is_cleared()
    {
        string username = Unique("wrong");
        await _host.CreateUserAsync(UserRole.Tier1, username);

        (LoginViewModel login, SessionStore session, _) = CreateLogin();

        login.Username = username;
        login.Password = "definitely-not-the-password";

        await login.SignInCommand.ExecuteAsync(null);

        Assert.Equal(SignInProblem.Credentials, login.Problem);
        Assert.False(session.IsSignedIn);
        Assert.Equal(string.Empty, login.Password);
        Assert.NotNull(login.Guidance);
    }

    /// <summary>
    /// The server returns 403 for both a wrong password and a locked account, so
    /// the console has only the wording to go on. This is the test that catches
    /// it if the server's wording changes and the two silently merge.
    /// </summary>
    [Fact]
    public async Task A_locked_account_is_distinguishable_from_a_wrong_password()
    {
        string username = Unique("lock");
        await _host.CreateUserAsync(UserRole.Tier1, username);

        (LoginViewModel login, _, _) = CreateLogin();
        login.Username = username;

        // The server locks after five failures; drive it there through the real
        // endpoint rather than writing a lockout straight into the database.
        for (int attempt = 0; attempt < 5; attempt++)
        {
            login.Password = $"wrong-{attempt}";
            await login.SignInCommand.ExecuteAsync(null);
        }

        Assert.Equal(SignInProblem.Credentials, login.Problem);

        // Now the correct password, against a locked account.
        login.Password = ConsoleTestHost.KnownPassword;
        await login.SignInCommand.ExecuteAsync(null);

        Assert.Equal(SignInProblem.Locked, login.Problem);
        Assert.Contains("lock", login.ErrorMessage!, StringComparison.OrdinalIgnoreCase);
        Assert.NotEqual(login.Guidance, new LoginViewModel(
            _host.CreateConsole().Api, new SessionStore(), NullLiveRegionAnnouncer.Instance).Guidance);
    }

    [Fact]
    public async Task An_unreachable_server_is_reported_as_unreachable_not_as_bad_credentials()
    {
        // A client pointed at a port nothing is listening on: the transport
        // failure the console has to tell apart from a refusal.
        var session = new SessionStore();
        using var http = new HttpClient(new BearerTokenHandler(session)
        {
            InnerHandler = new HttpClientHandler()
        })
        {
            BaseAddress = new Uri("http://127.0.0.1:1/"),
            Timeout = TimeSpan.FromSeconds(5)
        };

        var login = new LoginViewModel(
            new ApiClient(http, session), session, NullLiveRegionAnnouncer.Instance)
        {
            Username = "someone",
            Password = "something"
        };

        await login.SignInCommand.ExecuteAsync(null);

        Assert.Equal(SignInProblem.Unreachable, login.Problem);
        Assert.False(session.IsSignedIn);
        Assert.Contains("could not be reached", login.ErrorMessage!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_first_login_is_held_at_the_change_password_step()
    {
        string username = Unique("first");
        await _host.CreateUserAsync(UserRole.Supervisor, username, mustChangePassword: true);

        (LoginViewModel login, SessionStore session, RecordingLiveRegionAnnouncer announcer) =
            CreateLogin();

        login.Username = username;
        login.Password = ConsoleTestHost.KnownPassword;

        bool signalledReady = false;
        login.SignedIn += (_, _) => signalledReady = true;

        await login.SignInCommand.ExecuteAsync(null);

        Assert.True(login.MustChangePassword);
        Assert.False(signalledReady);
        Assert.True(session.MustChangePassword);
        Assert.True(announcer.Any("new password"));
    }

    [Fact]
    public async Task Changing_the_password_completes_the_first_login()
    {
        string username = Unique("change");
        await _host.CreateUserAsync(UserRole.Supervisor, username, mustChangePassword: true);

        (LoginViewModel login, SessionStore session, _) = CreateLogin();

        login.Username = username;
        login.Password = ConsoleTestHost.KnownPassword;
        await login.SignInCommand.ExecuteAsync(null);

        Assert.True(login.MustChangePassword);

        // SignInAsync clears the password; the user retypes it to confirm the
        // change, exactly as the UI requires.
        login.Password = ConsoleTestHost.KnownPassword;
        login.NewPassword = "An0ther!Strong-Password";
        login.ConfirmNewPassword = "An0ther!Strong-Password";

        bool signalledReady = false;
        login.SignedIn += (_, _) => signalledReady = true;

        await login.ChangePasswordCommand.ExecuteAsync(null);

        Assert.Null(login.ErrorMessage);
        Assert.False(login.MustChangePassword);
        Assert.False(session.MustChangePassword);
        Assert.True(signalledReady);
    }

    [Fact]
    public async Task Mismatched_new_passwords_are_caught_before_the_server_is_asked()
    {
        string username = Unique("mismatch");
        await _host.CreateUserAsync(UserRole.Supervisor, username, mustChangePassword: true);

        (LoginViewModel login, _, _) = CreateLogin();

        login.Username = username;
        login.Password = ConsoleTestHost.KnownPassword;
        await login.SignInCommand.ExecuteAsync(null);

        login.Password = ConsoleTestHost.KnownPassword;
        login.NewPassword = "An0ther!Strong-Password";
        login.ConfirmNewPassword = "An0ther!Strong-Passwerd";

        await login.ChangePasswordCommand.ExecuteAsync(null);

        Assert.Equal("The two new passwords do not match.", login.ErrorMessage);
        Assert.True(login.MustChangePassword);
    }

    [Fact]
    public async Task A_weak_new_password_surfaces_the_servers_own_wording()
    {
        string username = Unique("weak");
        await _host.CreateUserAsync(UserRole.Supervisor, username, mustChangePassword: true);

        (LoginViewModel login, _, _) = CreateLogin();

        login.Username = username;
        login.Password = ConsoleTestHost.KnownPassword;
        await login.SignInCommand.ExecuteAsync(null);

        login.Password = ConsoleTestHost.KnownPassword;
        login.NewPassword = "short";
        login.ConfirmNewPassword = "short";

        await login.ChangePasswordCommand.ExecuteAsync(null);

        // Whatever the server's policy says, the user reads it rather than a
        // guess the console made about what the policy might be.
        Assert.NotNull(login.ErrorMessage);
        Assert.True(login.MustChangePassword);
    }

    [Fact]
    public void Signing_out_discards_the_token_and_every_identity_fact()
    {
        var session = new SessionStore();

        session.SignIn("a-token", DateTime.UtcNow.AddMinutes(30), "Someone", UserRole.Supervisor, false);
        session.AttachIdentity(Guid.NewGuid(), "someone", UserRole.Supervisor, false);

        Assert.True(session.IsSignedIn);

        session.SignOut();

        Assert.False(session.IsSignedIn);
        Assert.Null(session.AccessToken);
        Assert.Null(session.UserId);
        Assert.Null(session.Role);
        Assert.Null(session.DisplayName);
        Assert.Null(session.ExpiresUtc);
    }
}
