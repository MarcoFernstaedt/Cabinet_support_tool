using System.Windows;
using System.Windows.Controls;
using CabinetPlatform.Console.Core.ViewModels;

namespace CabinetPlatform.Console.Views;

public partial class StaffView : UserControl
{
    public StaffView()
    {
        InitializeComponent();
        Unloaded += (_, _) => TemporaryPassword.Clear();
        IsVisibleChanged += (_, _) => { if (!IsVisible) TemporaryPassword.Clear(); };
    }

    private async void CreateAccount(object sender, RoutedEventArgs e)
    {
        if (DataContext is not StaffViewModel vm) return;
        string password = TemporaryPassword.Password;
        TemporaryPassword.Clear();
        if (vm.CreateCommand.CanExecute(password)) await vm.CreateCommand.ExecuteAsync(password);
    }
}
