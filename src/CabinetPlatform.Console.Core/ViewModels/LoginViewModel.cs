using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Users;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>What went wrong signing in, in the terms the user needs.</summary>
public enum SignInProblem
{
    None,

    /// <summary>Username or password wrong. The user tries again.</summary>
    Credentials,

    /// <summary>Locked out. Trying again now will not help; waiting will.</summary>
    Locked,

    /// <summary>Too many attempts from this machine. Also a wait, but a shorter one.</summary>
    RateLimited,

    /// <summary>The server could not be reached at all. Nothing to do with the credential.</summary>
    Unreachable,

    /// <summary>The server answered, but with a fault.</summary>
    ServerFault
}

/// <summary>
/// Sign-in, and the forced password change that follows a first login or a
/// reset.
/// </summary>
/// <remarks>
/// The three refusals a user actually hits — wrong password, locked account,
/// server down — are told apart and worded differently. Collapsing them into
/// "Sign-in failed" is the difference between an engineer retyping their
/// password for five minutes and an engineer phoning the person whose server is
/// down.
/// </remarks>
public sealed partial class LoginViewModel : ObservableViewModelBase
{
    private readonly IApiClient _api;
    private readonly ISessionStore _session;

    public LoginViewModel(IApiClient api, ISessionStore session, ILiveRegionAnnouncer announcer)
        : base(announcer)
    {
        _api = api;
        _session = session;
    }

    /// <summary>Raised once the session is fully usable, password change included.</summary>
    public event EventHandler? SignedIn;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand))]
    private string _username = string.Empty;

    /// <summary>
    /// Held only for the moment between the keystroke and the request, and
    /// cleared the instant the server has answered — on success and on failure
    /// alike. Never written anywhere.
    /// </summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand))]
    private string _password = string.Empty;

    [ObservableProperty]
    private SignInProblem _problem = SignInProblem.None;

    /// <summary>
    /// True once the server has accepted the credential but requires a new
    /// password before anything else. The view swaps to the change-password
    /// fields; there is no way past this screen, because the server's role
    /// policies will refuse every other call until the password changes.
    /// </summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(ChangePasswordCommand))]
    private bool _mustChangePassword;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(ChangePasswordCommand))]
    private string _newPassword = string.Empty;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(ChangePasswordCommand))]
    private string _confirmNewPassword = string.Empty;

    public string DisplayName => _session.DisplayName ?? string.Empty;

    /// <summary>
    /// Advice that follows from the specific failure. Shown beneath the message
    /// so the user is told what to do, not only that something broke.
    /// </summary>
    public string? Guidance => Problem switch
    {
        SignInProblem.Credentials =>
            "Check the username and password. Repeated failures will lock the account.",
        SignInProblem.Locked =>
            "The lockout clears on its own after a short time. A Supervisor can also clear it.",
        SignInProblem.RateLimited =>
            "Wait a minute before trying again.",
        SignInProblem.Unreachable =>
            "Check the network connection, then confirm the support server is running.",
        SignInProblem.ServerFault =>
            "Nothing was changed. If this persists, the server needs attention.",
        _ => null
    };

    partial void OnProblemChanged(SignInProblem value) => OnPropertyChanged(nameof(Guidance));

    private bool CanSignIn =>
        !IsLoading &&
        !string.IsNullOrWhiteSpace(Username) &&
        !string.IsNullOrEmpty(Password);

    protected override void OnLoadingChanged(bool isLoading)
    {
        SignInCommand.NotifyCanExecuteChanged();
        ChangePasswordCommand.NotifyCanExecuteChanged();
    }

    [RelayCommand(CanExecute = nameof(CanSignIn))]
    private async Task SignInAsync()
    {
        Problem = SignInProblem.None;

        var request = new LoginRequest { Username = Username.Trim(), Password = Password };

        LoginResponse? response = await RunAsync(ct => _api.LoginAsync(request, ct));

        // Cleared whatever happened. A failed attempt leaves the password in the
        // box on most sign-in forms; here it does not, because the next person
        // at this desk is not necessarily the same person.
        Password = string.Empty;

        if (response is null)
        {
            Problem = ClassifyLastFailure();
            return;
        }

        if (response.MustChangePassword)
        {
            MustChangePassword = true;
            OnPropertyChanged(nameof(DisplayName));

            const string message =
                "Signed in. You must choose a new password before you can continue.";

            ErrorMessage = null;
            Announcer.AnnounceImportant(message);
            return;
        }

        Announcer.Announce($"Signed in as {response.DisplayName}.");
        SignedIn?.Invoke(this, EventArgs.Empty);
    }

    private bool CanChangePassword =>
        !IsLoading &&
        !string.IsNullOrEmpty(NewPassword) &&
        !string.IsNullOrEmpty(ConfirmNewPassword);

    [RelayCommand(CanExecute = nameof(CanChangePassword))]
    private async Task ChangePasswordAsync()
    {
        Problem = SignInProblem.None;

        if (!string.Equals(NewPassword, ConfirmNewPassword, StringComparison.Ordinal))
        {
            // Checked here rather than sent, because the server has no way to
            // know the two boxes disagreed and would answer about the first one.
            ErrorMessage = "The two new passwords do not match.";
            Announcer.AnnounceImportant(ErrorMessage);
            return;
        }

        // The current password is the one just used to sign in. The user still
        // has to type it: it is the only evidence that the person changing the
        // password is the person who signed in, and not whoever found the
        // machine unattended a minute later.
        var request = new ChangePasswordRequest
        {
            CurrentPassword = Password,
            NewPassword = NewPassword
        };

        if (string.IsNullOrEmpty(request.CurrentPassword))
        {
            ErrorMessage = "Enter your current password to confirm the change.";
            Announcer.AnnounceImportant(ErrorMessage);
            return;
        }

        bool changed = await RunAsync(ct => _api.ChangePasswordAsync(request, ct));

        Password = string.Empty;
        NewPassword = string.Empty;
        ConfirmNewPassword = string.Empty;

        if (!changed)
        {
            Problem = ClassifyLastFailure();
            return;
        }

        _session.MarkPasswordChanged();
        MustChangePassword = false;

        Announcer.AnnounceImportant("Password changed. Opening the console.");
        SignedIn?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>
    /// Resets everything typed. Called when the shell returns to this screen, so
    /// the next sign-in never begins with the previous user's username in the
    /// box.
    /// </summary>
    public void Reset()
    {
        Username = string.Empty;
        Password = string.Empty;
        NewPassword = string.Empty;
        ConfirmNewPassword = string.Empty;
        MustChangePassword = false;
        Problem = SignInProblem.None;
        ClearError();
    }

    /// <summary>
    /// Explains an involuntary return to this screen. Called by the shell when a
    /// token expires mid-session, so the user is told why they are back here
    /// rather than being left to assume the application lost their work.
    /// </summary>
    public void ExplainExpiredSession()
    {
        ErrorMessage = "Your session expired and you were signed out. Sign in again to continue.";
        Problem = SignInProblem.Credentials;
        Announcer.AnnounceImportant(ErrorMessage);
    }

    /// <summary>
    /// Drops everything typed into a password field.
    /// </summary>
    /// <remarks>
    /// Called by the host when the dialog closes, on cancel as well as on
    /// success. The sign-in paths clear as they go, but the cancel path has no
    /// natural moment to — and an abandoned dialog is exactly the case where a
    /// half-typed password would otherwise sit in memory for the rest of the
    /// session.
    /// </remarks>
    public void ClearSecrets()
    {
        Password = string.Empty;
        NewPassword = string.Empty;
        ConfirmNewPassword = string.Empty;
    }

    /// <summary>
    /// Maps the failure the base class recorded onto the user-facing category.
    /// </summary>
    private SignInProblem ClassifyLastFailure() => LastFailure switch
    {
        ApiFailure.InvalidCredentials => SignInProblem.Credentials,
        ApiFailure.AccountLocked => SignInProblem.Locked,
        ApiFailure.RateLimited => SignInProblem.RateLimited,
        ApiFailure.Unreachable => SignInProblem.Unreachable,
        ApiFailure.ServerError => SignInProblem.ServerFault,
        // A 400 from the change-password endpoint — a policy rejection, most
        // likely. The server's own message is already on screen.
        ApiFailure.Invalid => SignInProblem.None,
        ApiFailure.SessionExpired => SignInProblem.Credentials,
        _ => SignInProblem.ServerFault
    };
}
