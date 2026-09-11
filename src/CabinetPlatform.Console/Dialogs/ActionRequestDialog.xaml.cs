using System.Windows;
using CabinetPlatform.Console.Core.ViewModels;

namespace CabinetPlatform.Console.Dialogs;

/// <summary>
/// Collects a reason and a ticket reference before an action is submitted.
/// </summary>
/// <remarks>
/// Initial focus is on Cancel, placed declaratively in the XAML. Confirm is not
/// the default button, so Return does not submit — the user has to reach the
/// button deliberately.
/// </remarks>
public partial class ActionRequestDialog : Window
{
    public ActionRequestDialog() => InitializeComponent();

    private void OnSubmit(object sender, RoutedEventArgs e)
    {
        // Re-checked here as well as in the button's IsEnabled binding: a
        // disabled button is a courtesy, and the ViewModel is the rule.
        if (DataContext is ActionRequestDialogViewModel { CanSubmit: true })
        {
            DialogResult = true;
        }
    }
}
