using System.Globalization;
using System.Xml.Linq;

namespace CabinetPlatform.Console.Core.Tests;

// Source contracts complement, but cannot replace, native WPF/AT testing.
public sealed class DarkThemeAccessibilityTests
{
    private static readonly XNamespace X = "http://schemas.microsoft.com/winfx/2006/xaml";
    private static string Root
    {
        get
        {
            DirectoryInfo? root = new(AppContext.BaseDirectory);
            while (root is not null && !File.Exists(Path.Combine(root.FullName, "CabinetPlatform.sln"))) root = root.Parent;
            return root!.FullName;
        }
    }
    private static XDocument Load(string path) => XDocument.Load(Path.Combine(Root, "src/CabinetPlatform.Console", path));
    private static Dictionary<string, string> Palette(string name) => Load($"Resources/Theme.{name}.xaml")
        .Descendants().Where(e => e.Name.LocalName == "SolidColorBrush")
        .ToDictionary(e => (string)e.Attribute(X + "Key")!, e => (string)e.Attribute("Color")!);
    private static double Luminance(string hex)
    {
        double Channel(int start)
        {
            double value = int.Parse(hex.Substring(start, 2), NumberStyles.HexNumber) / 255d;
            return value <= .04045 ? value / 12.92 : Math.Pow((value + .055) / 1.055, 2.4);
        }
        return .2126 * Channel(1) + .7152 * Channel(3) + .0722 * Channel(5);
    }
    private static double Contrast(string a, string b)
    {
        double x = Luminance(a), y = Luminance(b);
        return (Math.Max(x, y) + .05) / (Math.Min(x, y) + .05);
    }
    [Fact]
    public void Dark_palette_has_readable_text_status_and_focus_on_both_surfaces()
    {
        var palette = Palette("Default");
        foreach (string surface in new[] { "Surface.Brush", "Surface.Alt.Brush" })
        {
            Assert.True(Luminance(palette[surface]) < .04, $"{surface} must be a dark surface");
            foreach (string text in new[] { "Text.Brush", "Text.Subtle.Brush", "Severity.Good.Brush", "Severity.Warning.Brush", "Severity.Critical.Brush", "Severity.Neutral.Brush", "Severity.Unknown.Brush" })
                Assert.True(Contrast(palette[text], palette[surface]) >= 4.5, $"{text} on {surface} needs 4.5:1");
            Assert.True(Contrast(palette["Focus.Brush"], palette[surface]) >= 3);
            Assert.True(Contrast(palette["Border.Brush"], palette[surface]) >= 3);
        }
        Assert.True(Contrast(palette["Badge.Text.Brush"], palette["Badge.Background.Brush"]) >= 4.5);
    }
    [Fact]
    public void Shared_controls_keep_native_templates_with_explicit_focus_and_paired_colors()
    {
        var shared = Load("Resources/Shared.xaml");
        var styles = shared.Descendants().Where(e => e.Name.LocalName == "Style").ToList();
        foreach (string type in new[] { "Button", "TextBox", "PasswordBox", "ComboBox", "CheckBox", "Expander", "TabItem", "DataGridCell" })
        {
            var style = Assert.Single(styles, e => (string?)e.Attribute("TargetType") == type && e.Attribute(X + "Key") is null);
            Assert.Contains(style.Elements(), e => (string?)e.Attribute("Property") == "FocusVisualStyle");
            Assert.Contains(style.Elements(), e => (string?)e.Attribute("Property") == "Foreground");
            Assert.DoesNotContain(style.Descendants(), e => (string?)e.Attribute("Property") == "Template");
        }
        var row = styles.Single(e => (string?)e.Attribute(X + "Key") == "AccessibleRow");
        Assert.Contains(row.Elements(), e => (string?)e.Attribute("Property") == "Background" && (string?)e.Attribute("Value") == "{DynamicResource Surface.Brush}");
        Assert.Contains(row.Descendants(), e => (string?)e.Attribute("Property") == "IsSelected");
        Assert.Contains(shared.Descendants(), e => (string?)e.Attribute(X + "Key") == "KeyboardFocusVisual");
        var shell = Load("Views/MainWindow.xaml");
        Assert.DoesNotContain(shell.Descendants(), e => (string?)e.Attribute("Foreground") == "White");
        Assert.Contains(shell.Descendants(), e => (string?)e.Attribute("Foreground") == "{DynamicResource Badge.Text.Brush}");
    }

    [Fact]
    public void Dark_view_roots_set_foreground_instead_of_inheriting_native_tab_header_text()
    {
        foreach (var file in Directory.GetFiles(Path.Combine(Root, "src/CabinetPlatform.Console"), "*.xaml", SearchOption.AllDirectories).Where(f => !f.Contains("/obj/")))
        {
            var root = XDocument.Load(file).Root!;
            if (root.Name.LocalName is "Window" or "UserControl")
                Assert.True((string?)root.Attribute("Foreground") == "{DynamicResource Text.Brush}", file);
        }
    }

    [Fact]
    public void Process_and_event_status_names_expose_the_result_not_only_a_static_caption()
    {
        var machine = Load("Views/MachineTabView.xaml");
        foreach (string binding in new[] { "FilterSummary", "SelectedProcess.AccessibleSummary", "ViewCreationStatus", "ResultSummary" })
        {
            var text = Assert.Single(machine.Descendants().Where(e => e.Ancestors().Any(a => (string?)a.Attribute("DataContext") is "{Binding Processes}" or "{Binding EventLogs}")), e => (string?)e.Attribute("Text") == $"{{Binding {binding}}}");
            Assert.Equal("{Binding Text, RelativeSource={RelativeSource Self}}", (string?)text.Attribute("AutomationProperties.Name"));
        }
        var filter = machine.Descendants().Single(e => (string?)e.Attribute("AutomationProperties.Name") == "Filter processes by name or process id");
        Assert.NotNull(filter.Attribute(X + "Name"));
        Assert.Contains(machine.Descendants(), e => (string?)e.Attribute("Target") == "{Binding ElementName=ProcessFilter}");
        var registration = Load("Views/RegistrationsView.xaml");
        foreach (string name in new[] { "Client", "Site", "Reason" })
        {
            var field = registration.Descendants().Single(e => (string?)e.Attribute(X + "Name") == name);
            Assert.Contains("required", (string?)field.Attribute("AutomationProperties.HelpText") ?? "");
        }
        // Status must remain represented in words when all severity colors collapse.
        Assert.Contains(registration.Descendants(), e => (string?)e.Attribute("Binding") == "{Binding Status}");
        foreach (string binding in new[] { "Access", "Level" })
            Assert.Contains(machine.Descendants(), e => (string?)e.Attribute("Binding") == $"{{Binding {binding}}}");
        Assert.Contains(Load("Resources/Shared.xaml").Descendants(), e => (string?)e.Attribute("Text") == "{Binding Label}");
    }

    [Fact]
    public void High_contrast_covers_every_token_with_live_system_colors()
    {
        var normal = Palette("Default");
        var high = Palette("HighContrast");
        Assert.Equal(normal.Keys.Order(), high.Keys.Order());
        Assert.All(high.Values, value => Assert.StartsWith("{DynamicResource {x:Static SystemColors.", value));
    }
}
