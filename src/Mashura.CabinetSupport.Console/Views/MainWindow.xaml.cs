using System.Windows;

namespace Mashura.CabinetSupport.Console.Views;

/// <summary>
/// The main window. Layout only — every behaviour behind it lives in
/// <see cref="Core.ViewModels.ShellViewModel"/>.
/// </summary>
public partial class MainWindow : Window
{
    public MainWindow() => InitializeComponent();
}
