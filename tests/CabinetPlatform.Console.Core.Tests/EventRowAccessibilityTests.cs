using System.Globalization;
using System.Xml.Linq;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests;

// Source/type contracts only: Windows UIA and screen-reader verification remain separate.
public sealed class EventRowAccessibilityTests
{
    [Theory]
    [InlineData("Channels", typeof(EventChannelInfo), nameof(EventChannelInfo.Name), nameof(EventChannelInfo.Access))]
    [InlineData("ChannelReads", typeof(EventChannelReadResult), nameof(EventChannelReadResult.Name), nameof(EventChannelReadResult.Access))]
    [InlineData("Entries", typeof(EventLogEntry), nameof(EventLogEntry.DisplayChannelName), nameof(EventLogEntry.EventId))]
    public void Event_row_names_bind_real_item_properties_and_keep_native_row_style(
        string collection, Type itemType, string identity, string outcome)
    {
        DirectoryInfo? root = new(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "CabinetPlatform.sln")))
            root = root.Parent;
        Assert.NotNull(root);
        var document = XDocument.Load(Path.Combine(root.FullName,
            "src/CabinetPlatform.Console/Views/MachineTabView.xaml"));
        XNamespace wpf = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
        var grid = Assert.Single(document.Descendants(wpf + "DataGrid"),
            e => (string?)e.Attribute("ItemsSource") == $"{{Binding {collection}}}");
        var collectionType = typeof(EventLogSectionViewModel).GetProperty(collection)!.PropertyType;
        Assert.Contains(collectionType.GetInterfaces(),
            t => t.IsGenericType && t.GetGenericTypeDefinition() == typeof(IEnumerable<>) && t.GenericTypeArguments[0] == itemType);
        var rowStyle = grid.Element(wpf + "DataGrid.RowStyle");
        Assert.NotNull(rowStyle);
        var style = Assert.Single(rowStyle.Elements(wpf + "Style"));
        Assert.Equal("DataGridRow", (string?)style.Attribute("TargetType"));
        Assert.Equal("{StaticResource AccessibleRow}", (string?)style.Attribute("BasedOn"));
        var setter = Assert.Single(style.Elements(wpf + "Setter"),
            e => (string?)e.Attribute("Property") == "AutomationProperties.Name");
        var binding = Assert.Single(setter.Descendants(wpf + "MultiBinding"));
        var paths = binding.Elements(wpf + "Binding").Select(e => (string)e.Attribute("Path")!).ToArray();
        Assert.Contains(identity, paths);
        Assert.Contains(outcome, paths);
        Assert.All(paths, path => Assert.NotNull(itemType.GetProperty(path)));
        var format = (string)binding.Attribute("StringFormat")!;
        var values = paths.Select((_, i) => (object)$"field{i}").ToArray();
        var rendered = string.Format(CultureInfo.InvariantCulture, format, values);
        Assert.All(values, value => Assert.Contains((string)value, rendered));
        Assert.DoesNotContain(style.Descendants(), e => (string?)e.Attribute("Property") is "Template" or "OverridesDefaultStyle");
    }
}
