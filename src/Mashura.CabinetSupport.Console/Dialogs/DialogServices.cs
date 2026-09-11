using System.Windows;
using System.Windows.Threading;
using Mashura.CabinetSupport.Console.Core.Presentation;
using Mashura.CabinetSupport.Console.Core.ViewModels;

namespace Mashura.CabinetSupport.Console.Dialogs;

/// <summary>
/// Shows the reason-and-ticket dialog on the UI thread and returns what the user
/// supplied.
/// </summary>
/// <remarks>
/// The whole WPF-specific part of the action flow is here: three lines of
/// window plumbing. Everything worth testing — the warnings, the validation, the
/// submission shape — is in
/// <see cref="ActionRequestDialogViewModel"/>, which has no WPF dependency.
/// </remarks>
public sealed class ActionRequestDialogService : IActionRequestDialog
{
    private readonly Dispatcher _dispatcher;
    private readonly ILiveRegionAnnouncer _announcer;

    public ActionRequestDialogService(ILiveRegionAnnouncer announcer)
    {
        _dispatcher = Application.Current.Dispatcher;
        _announcer = announcer;
    }

    public Task<ActionRequestSubmission?> ShowAsync(ActionRequestPrompt prompt, CancellationToken ct)
    {
        if (!_dispatcher.CheckAccess())
        {
            return _dispatcher.InvokeAsync(() => Show(prompt)).Task;
        }

        return Task.FromResult(Show(prompt));
    }

    private ActionRequestSubmission? Show(ActionRequestPrompt prompt)
    {
        var viewModel = new ActionRequestDialogViewModel(prompt);

        var dialog = new ActionRequestDialog
        {
            DataContext = viewModel,
            Owner = Application.Current.MainWindow is { IsVisible: true } owner ? owner : null
        };

        // Announced as it opens, so the consequence is heard before anything is
        // typed rather than discovered by tabbing through the warnings.
        _announcer.AnnounceImportant(viewModel.AccessibleSummary);

        return dialog.ShowDialog() == true ? viewModel.BuildSubmission() : null;
    }
}

/// <summary>Shows the approve-or-deny confirmation.</summary>
public sealed class ApprovalDecisionDialogService : IApprovalDecisionDialog
{
    private readonly Dispatcher _dispatcher;
    private readonly ILiveRegionAnnouncer _announcer;
    private readonly TimeProvider _timeProvider;

    public ApprovalDecisionDialogService(ILiveRegionAnnouncer announcer, TimeProvider timeProvider)
    {
        _dispatcher = Application.Current.Dispatcher;
        _announcer = announcer;
        _timeProvider = timeProvider;
    }

    public Task<ApprovalDecisionSubmission?> ShowAsync(
        ApprovalDecisionPrompt prompt, CancellationToken ct)
    {
        if (!_dispatcher.CheckAccess())
        {
            return _dispatcher.InvokeAsync(() => Show(prompt)).Task;
        }

        return Task.FromResult(Show(prompt));
    }

    private ApprovalDecisionSubmission? Show(ApprovalDecisionPrompt prompt)
    {
        var viewModel = new ApprovalDecisionDialogViewModel(
            prompt, _timeProvider.GetUtcNow().UtcDateTime);

        var dialog = new ApprovalDecisionDialog
        {
            DataContext = viewModel,
            Owner = Application.Current.MainWindow is { IsVisible: true } owner ? owner : null
        };

        _announcer.AnnounceImportant(viewModel.AccessibleSummary);

        return dialog.ShowDialog() == true ? viewModel.BuildSubmission() : null;
    }
}
