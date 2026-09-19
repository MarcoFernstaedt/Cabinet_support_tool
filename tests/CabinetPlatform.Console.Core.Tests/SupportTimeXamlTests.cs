using System.Xml.Linq;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class SupportTimeXamlTests
{
    [Theory]
    [InlineData("RegistrationsView.xaml", "FirstSeenUtc")]
    [InlineData("RegistrationsView.xaml", "LastSeenUtc")]
    [InlineData("MachineTabView.xaml", "TimeCreatedUtc")]
    public void Raw_event_and_enrollment_instants_bind_the_fixed_support_formatter(string file, string property)
    {
        DirectoryInfo? root = new(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "CabinetPlatform.sln"))) root = root.Parent;
        Assert.NotNull(root);
        var document = XDocument.Load(Path.Combine(root.FullName, "src/CabinetPlatform.Console/Views", file));
        var column = Assert.Single(document.Descendants(), e => e.Name.LocalName == "DataGridTextColumn" &&
            ((string?)e.Attribute("Binding"))?.StartsWith("{Binding " + property, StringComparison.Ordinal) == true);
        Assert.Contains("Converter={StaticResource SupportTime}", (string)column.Attribute("Binding")!);
        var app = XDocument.Load(Path.Combine(root.FullName, "src/CabinetPlatform.Console/App.xaml"));
        Assert.Contains(app.Descendants(), e => e.Name.LocalName == "SupportTimeConverter");
    }
}
