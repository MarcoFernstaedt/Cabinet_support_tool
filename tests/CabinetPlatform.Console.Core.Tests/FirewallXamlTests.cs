using System.Xml.Linq;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class FirewallXamlTests
{
    [Fact]
    public void Inspection_section_exposes_read_only_rows_outcomes_and_the_real_action_strip()
    {
        DirectoryInfo? root = new(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "CabinetPlatform.sln"))) root = root.Parent;
        Assert.NotNull(root);
        var document = XDocument.Load(Path.Combine(root!.FullName, "src/CabinetPlatform.Console/Views/MachineTabView.xaml"));
        var section = Assert.Single(document.Descendants(), e => e.Name.LocalName == "StackPanel" && (string?)e.Attribute("DataContext") == "{Binding Firewall}");
        foreach (var field in new[] { "ResultSummary", "PolicyCaveat", "RepairStatus" })
            Assert.Contains(section.Descendants(), e => (string?)e.Attribute("Text") == "{Binding " + field + "}");
        foreach (var field in new[] { "Rules", "Profiles" })
        {
            var grid = Assert.Single(section.Descendants(), e => e.Name.LocalName == "DataGrid" && (string?)e.Attribute("ItemsSource") == "{Binding " + field + "}");
            Assert.Equal("True", (string?)grid.Attribute("IsReadOnly"));
            Assert.NotNull(grid.Attribute("AutomationProperties.Name"));
        }
        Assert.Contains(section.Descendants(), e => (string?)e.Attribute("ContentTemplate") == "{StaticResource SectionActionsTemplate}");
    }
}
