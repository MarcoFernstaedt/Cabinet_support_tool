using System.Xml.Linq;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class EnrollmentWiringTests
{
    [Fact]
    public void Supervisor_enrollment_queue_is_reachable_from_the_real_main_window()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "CabinetPlatform.sln"))) root = root.Parent;
        Assert.NotNull(root);
        var main = XDocument.Load(Path.Combine(root.FullName, "src/CabinetPlatform.Console/Views/MainWindow.xaml"));
        var entry = Assert.Single(main.Descendants(), e => (string?)e.Attribute("Command") == "{Binding ShowRegistrationsCommand}");
        Assert.Equal("{Binding CanSeeRegistrations, Converter={StaticResource BoolToVisibility}}", (string?)entry.Attribute("Visibility"));
        var view = Assert.Single(main.Descendants(), e => e.Name.LocalName == "RegistrationsView");
        Assert.Equal("{Binding Registrations}", (string?)view.Attribute("DataContext"));
        var queue = XDocument.Load(Path.Combine(root.FullName, "src/CabinetPlatform.Console/Views/RegistrationsView.xaml"));
        Assert.Contains(queue.Descendants(), e => (string?)e.Attribute("Command") == "{Binding AcceptCommand}");
        Assert.Contains(queue.Descendants(), e => (string?)e.Attribute("Command") == "{Binding RejectCommand}");
        Assert.Contains(queue.Descendants(), e => (string?)e.Attribute("ItemsSource") == "{Binding Queue}");
        Assert.Contains(queue.Descendants(), e => (string?)e.Attribute("SelectedItem") == "{Binding SelectedRegistration}");
        var rowStyle = Assert.Single(queue.Descendants(), e => e.Name.LocalName == "DataGrid.RowStyle");
        Assert.Contains(rowStyle.Descendants(), e => e.Name.LocalName == "Binding" && (string?)e.Attribute("Path") == "MachineId");
        Assert.Contains(rowStyle.Descendants(), e => e.Name.LocalName == "Binding" && (string?)e.Attribute("Path") == "Status");
    }
}
