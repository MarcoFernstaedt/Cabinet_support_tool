using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Api;

namespace CabinetPlatform.Console.Core.Presentation;

/// <summary>
/// The three states every asynchronous screen in this console has to render:
/// loading, failed, and loaded.
/// </summary>
/// <remarks>
/// <para>
/// All three are handled here once rather than per screen, because the one that
/// gets skipped in a hurry is always the middle one. A view that shows a spinner
/// and then silently shows nothing is the single most common way a support tool
/// convinces an engineer that a clinic has no pending updates when in fact the
/// request failed.
/// </para>
/// <para>
/// <see cref="RunAsync"/> also owns cancellation. Each load supersedes the one
/// before it, and <see cref="Deactivate"/> cancels whatever is in flight when
/// the user navigates away, so a slow response for the cabinet they just left
/// can never arrive and overwrite the one they are now looking at.
/// </para>
/// </remarks>
public abstract partial class ObservableViewModelBase : ObservableObject
{
    private CancellationTokenSource? _inFlight;
    private int _loadDepth;

    protected ObservableViewModelBase(ILiveRegionAnnouncer announcer) => Announcer = announcer;

    protected ILiveRegionAnnouncer Announcer { get; }

    [ObservableProperty]
    private bool _isLoading;

    /// <summary>
    /// The failure the user needs to read, or null. Set from the server's own
    /// wording wherever there is some.
    /// </summary>
    [ObservableProperty]
    private string? _errorMessage;

    /// <summary>
    /// True when a failure needs the user to sign in again. The shell watches
    /// this so an expired token does not look like a broken server.
    /// </summary>
    [ObservableProperty]
    private bool _requiresReauthentication;

    public bool HasError => !string.IsNullOrEmpty(ErrorMessage);

    /// <summary>
    /// The category of the most recent failure, or null after a success.
    /// </summary>
    /// <remarks>
    /// Kept apart from <see cref="ErrorMessage"/> because the two answer
    /// different questions. The message is the server's wording, shown as-is;
    /// this is the machine-readable reason a screen may need in order to behave
    /// differently — offering a Retry for an unreachable server but not for a
    /// refusal, say, or telling a locked-out account apart from a mistyped
    /// password when both arrive as HTTP 403.
    /// </remarks>
    public ApiFailure? LastFailure { get; private set; }

    partial void OnErrorMessageChanged(string? value) => OnPropertyChanged(nameof(HasError));

    partial void OnIsLoadingChanged(bool value) => OnLoadingChanged(value);

    /// <summary>
    /// Called whenever the spinner turns on or off. Derived screens override it
    /// to re-evaluate their commands, since nearly every button in this console
    /// is disabled while its screen is loading.
    /// </summary>
    protected virtual void OnLoadingChanged(bool isLoading)
    {
    }

    /// <summary>
    /// Runs one load: clears the previous error, shows the spinner, cancels any
    /// earlier load, and turns a failure into a message the view can show.
    /// </summary>
    /// <returns>True when the work completed; false when it failed or was superseded.</returns>
    protected async Task<bool> RunAsync(Func<CancellationToken, Task> work)
    {
        CancellationTokenSource cts = BeginLoad();

        try
        {
            await work(cts.Token);
            cts.Token.ThrowIfCancellationRequested();
            return true;
        }
        catch (OperationCanceledException)
        {
            // Superseded or navigated away. Not a failure, and not the user's
            // business: leaving the previous error on screen would be, though,
            // so it stays cleared.
            return false;
        }
        catch (ApiException ex)
        {
            if (!cts.IsCancellationRequested) Fail(ex);
            return false;
        }
        finally
        {
            EndLoad(cts);
        }
    }

    /// <summary>
    /// Runs one load that produces a value, so a caller can act on the result
    /// without repeating the error handling.
    /// </summary>
    protected async Task<T?> RunAsync<T>(Func<CancellationToken, Task<T>> work)
    {
        CancellationTokenSource cts = BeginLoad();

        try
        {
            T result = await work(cts.Token);
            cts.Token.ThrowIfCancellationRequested();
            return result;
        }
        catch (OperationCanceledException)
        {
            return default;
        }
        catch (ApiException ex)
        {
            if (!cts.IsCancellationRequested) Fail(ex);
            return default;
        }
        finally
        {
            EndLoad(cts);
        }
    }

    /// <summary>
    /// Records a failure and announces it, because a message that only appears
    /// visually has not been delivered to every user of this console.
    /// </summary>
    protected void Fail(ApiException ex)
    {
        LastFailure = ex.Failure;
        ErrorMessage = ex.Message;
        RequiresReauthentication = ex.RequiresReauthentication;
        Announcer.AnnounceImportant(ex.Message);
    }

    /// <summary>
    /// Puts a failure back on screen without announcing it again.
    /// </summary>
    /// <remarks>
    /// Needed because every load clears the error first, so a screen that
    /// reloads in response to a failure would wipe the very message the user
    /// needs — leaving a row that silently disappeared and no explanation. The
    /// announcement is not repeated: the user heard it once already, and saying
    /// it twice is worse than saying it once.
    /// </remarks>
    protected void RestoreError(ApiFailure failure, string message)
    {
        LastFailure = failure;
        ErrorMessage = message;
        RequiresReauthentication = failure == ApiFailure.SessionExpired;
    }

    protected void ClearError()
    {
        LastFailure = null;
        ErrorMessage = null;
        RequiresReauthentication = false;
    }

    /// <summary>
    /// Cancels work in flight. Called when the view is navigated away from, so
    /// a response for a cabinet the user has left cannot land on the one they
    /// are now looking at.
    /// </summary>
    public virtual void Deactivate() => CancelInFlight();

    private CancellationTokenSource BeginLoad()
    {
        CancelInFlight();

        CancellationTokenSource cts = new();
        _inFlight = cts;

        ClearError();
        _loadDepth++;
        IsLoading = true;

        return cts;
    }

    private void EndLoad(CancellationTokenSource cts)
    {
        // Only the newest load may clear the spinner. Otherwise a superseded
        // load finishing late turns it off while its replacement is still
        // running, and the screen claims to be settled when it is not.
        if (ReferenceEquals(_inFlight, cts))
        {
            _inFlight = null;
            IsLoading = false;
        }

        _loadDepth = Math.Max(0, _loadDepth - 1);

        if (_loadDepth == 0)
        {
            IsLoading = false;
        }

        cts.Dispose();
    }

    private void CancelInFlight()
    {
        CancellationTokenSource? previous = _inFlight;
        _inFlight = null;

        if (previous is null)
        {
            return;
        }

        try
        {
            previous.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Already finished and disposed; nothing to cancel.
        }
    }
}
