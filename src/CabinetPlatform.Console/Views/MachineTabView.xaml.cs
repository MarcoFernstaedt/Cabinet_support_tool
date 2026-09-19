using System.Windows.Controls;
using System.Windows.Threading;
using CabinetPlatform.Console.Core.ViewModels;

namespace CabinetPlatform.Console.Views;

/// <summary>Refreshes presentation age on the UI thread; never polls a cabinet.</summary>
public partial class MachineTabView : UserControl
{
    private readonly DispatcherTimer _freshnessTimer = new() { Interval = TimeSpan.FromSeconds(15) };

    public MachineTabView()
    {
        InitializeComponent();
        _freshnessTimer.Tick += (_, _) => RefreshAge();
        Loaded += (_, _) => { RefreshAge(); _freshnessTimer.Start(); };
        Unloaded += (_, _) => _freshnessTimer.Stop();
        DataContextChanged += (_, _) => RefreshAge();
    }

    private void RefreshAge()
    {
        if (DataContext is MachineTabViewModel model) model.RefreshFreshness();
    }
}
