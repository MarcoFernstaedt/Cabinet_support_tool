using System.Windows;
using CabinetPlatform.Console.Core.ViewModels;

namespace CabinetPlatform.Console.Views;

/// <summary>
/// Sign-in, and the forced password change that follows a first login.
/// </summary>
/// <remarks>
/// The code-behind does one thing: close the dialog when the ViewModel reports
/// a usable session. Deciding whether a session is usable — credentials
/// accepted and no password change outstanding — is the ViewModel's, and is
/// covered by tests.
/// </remarks>
public partial class LoginWindow : Window
{
    private LoginViewModel? _viewModel;

    public LoginWindow()
    {
        InitializeComponent();

        DataContextChanged += (_, e) =>
        {
            if (_viewModel is not null)
            {
                _viewModel.SignedIn -= OnSignedIn;
            }

            _viewModel = e.NewValue as LoginViewModel;

            if (_viewModel is not null)
            {
                _viewModel.SignedIn += OnSignedIn;
            }
        };

        Closed += (_, _) =>
        {
            if (_viewModel is not null)
            {
                _viewModel.SignedIn -= OnSignedIn;
            }
        };
    }

    private void OnSignedIn(object? sender, EventArgs e)
    {
        // Guarded: setting DialogResult on a window that was never shown
        // modally throws, and the same ViewModel instance is reused across
        // sign-ins.
        if (IsLoaded && IsVisible)
        {
            DialogResult = true;
        }
    }
}
