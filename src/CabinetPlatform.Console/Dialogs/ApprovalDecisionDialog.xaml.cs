using System.Windows;
using CabinetPlatform.Console.Core.ViewModels;

namespace CabinetPlatform.Console.Dialogs;

/// <summary>Confirms an approve or deny decision.</summary>
public partial class ApprovalDecisionDialog : Window
{
    public ApprovalDecisionDialog() => InitializeComponent();

    private void OnConfirm(object sender, RoutedEventArgs e)
    {
        if (DataContext is ApprovalDecisionDialogViewModel { CanConfirm: true })
        {
            DialogResult = true;
        }
    }
}
