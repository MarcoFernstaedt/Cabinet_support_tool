using System.Xml.Linq;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class NativeEventChannelXamlTests
{
    [Fact]
    public void Event_section_binds_discovery_selection_creation_and_exact_record_identity()
    {
        DirectoryInfo? root = new(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "CabinetPlatform.sln"))) root = root.Parent;
        Assert.NotNull(root);
        var document = XDocument.Load(Path.Combine(root!.FullName, "src/CabinetPlatform.Console/Views/MachineTabView.xaml"));
        var section = document.Descendants().Single(e => e.Name.LocalName == "StackPanel" && (string?)e.Attribute("DataContext") == "{Binding EventLogs}");
        var grid = Assert.Single(section.Descendants(), e => e.Name.LocalName == "DataGrid" && (string?)e.Attribute("ItemsSource") == "{Binding Channels}");
        Assert.Equal("{Binding SelectedChannel}", (string?)grid.Attribute("SelectedItem"));
        Assert.Contains(section.Descendants(), e => (string?)e.Attribute("Command") == "{Binding SaveChannelViewCommand}");
        Assert.Contains(section.Descendants(), e => (string?)e.Attribute("ItemsSource") == "{Binding ChannelReads}");
        Assert.Contains(section.Descendants(), e => (string?)e.Attribute("Binding") == "{Binding DisplayChannelName}");
        foreach (string field in new[] { "NewChannelName", "NewViewName", "NewViewReason" })
            Assert.Contains(section.Descendants(), e => e.Name.LocalName == "TextBox" && ((string?)e.Attribute("Text"))?.Contains(field, StringComparison.Ordinal) == true);
    }
}
