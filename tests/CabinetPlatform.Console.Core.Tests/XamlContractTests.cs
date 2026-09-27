using System.Reflection;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using CabinetPlatform.Console.Core.Presentation;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// Checks the WPF markup against the ViewModels it binds to, without compiling
/// WPF.
/// </summary>
/// <remarks>
/// <para>
/// A XAML binding to a property that does not exist is not a build error. It
/// fails silently at runtime — the control renders blank, and the only trace is
/// a line in the debug output nobody is reading. On a support tool, a silently
/// blank field is the worst possible failure mode: it looks exactly like a
/// cabinet with nothing to report.
/// </para>
/// <para>
/// These tests read the markup as XML and check every binding path and every
/// resource key against the Core assembly and the dictionaries. They are not a
/// substitute for running the application, and they cannot see a layout mistake
/// or a wrong visual state. They do catch the whole class of typo that would
/// otherwise reach a demo.
/// </para>
/// </remarks>
public sealed class XamlContractTests
{
    [Fact]
    public void Native_lifecycle_suppresses_automatic_startup_before_driving_one_loop()
    {
        var code = File.ReadAllText(Path.Combine(ProjectRoot, "tests/CabinetPlatform.Console.NativeTests/SessionLifecycle.cs"));
        Assert.Contains("new LifecycleApp()", code);
        Assert.Contains("protected override void OnStartup(StartupEventArgs e)", code);
        Assert.DoesNotContain("base.OnStartup(e)", code);
        Assert.Single(Regex.Matches(code, "GetMethod\\(\\\"StartAsync\\\""));
        Assert.Contains("app.StartupCount == 1", code);
    }

    [Fact]
    public void Native_lifecycle_owns_dispatcher_shutdown_even_on_failure()
    {
        var code = File.ReadAllText(Path.Combine(ProjectRoot, "tests/CabinetPlatform.Console.NativeTests/SessionLifecycle.cs"));
        Assert.Contains("finally { app.Dispatcher.BeginInvokeShutdown(DispatcherPriority.Background); }", code);
        Assert.Contains("finally\n            {\n                Stop();\n            }", code);
        Assert.Contains("DispatcherUnhandledException +=", code);
        Assert.Contains("if (forceFailure)", code);
        Assert.DoesNotContain("app.Shutdown(1)", code);
    }

    [Fact]
    public void Native_lifecycle_installs_non_network_transport_at_graph_construction()
    {
        var app = File.ReadAllText(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/App.xaml.cs"));
        var code = File.ReadAllText(Path.Combine(ProjectRoot, "tests/CabinetPlatform.Console.NativeTests/SessionLifecycle.cs"));
        Assert.Contains("protected virtual System.Net.Http.HttpMessageHandler CreateTransportHandler()", app);
        Assert.Contains(".ConfigurePrimaryHttpMessageHandler(CreateTransportHandler)", app);
        Assert.Contains("protected override HttpMessageHandler CreateTransportHandler()", code);
        Assert.Contains("CurrentHandler = new HeldHandler()", code);
        Assert.DoesNotContain("GetField(\"_http\"", code);
        Assert.DoesNotContain("field.SetValue", code);
        Assert.Contains("app.TransportCount == 3", code);
        Assert.Contains("app.Windows.OfType<LoginWindow>()", code);
        Assert.Contains("ReferenceEquals(login.DataContext, provider.GetRequiredService<LoginViewModel>())", code);
        Assert.DoesNotContain("HttpClientHandler", code);
        Assert.DoesNotContain("SocketsHttpHandler", code);
    }

    [Fact]
    public void App_recreates_the_session_graph_and_closes_the_old_window_before_reauthentication()
    {
        var code = File.ReadAllText(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/App.xaml.cs"));
        Assert.DoesNotContain("SignInAsync(window, reason)", code);
        Assert.Contains("while (true)", code);
        Assert.Contains("using ServiceProvider provider = services.BuildServiceProvider()", code);
        Assert.Contains("window.Close();", code);
        Assert.Contains("window.DataContext = null;", code);
        Assert.Contains("login.Deactivate();", code);
    }

    [Fact]
    public void Monitoring_header_is_persistent_focusable_and_announces_actual_words()
    {
        var xaml = XDocument.Load(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/Views/MachineTabView.xaml"));
        var banner = Assert.Single(xaml.Descendants(), e =>
            (string?)e.Attribute("Text") == "{Binding MonitoringNote}");
        Assert.Equal("True", (string?)banner.Attribute("Focusable"));
        Assert.Equal("{Binding MonitoringNote}", (string?)banner.Attribute("AutomationProperties.Name"));
        Assert.DoesNotContain(banner.Ancestors(), e => e.Name.LocalName == "ScrollViewer");
    }

    [Fact]
    public void Machine_snapshot_statuses_cannot_use_live_green_template()
    {
        var text = File.ReadAllText(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/Views/MachineTabView.xaml"));
        Assert.DoesNotContain("{StaticResource StatusTemplate}", text);
        Assert.Contains("HistoricalStatusTemplate", text);
        Assert.Contains("Last observed: {0}; current state unverified", text);
    }

    [Fact]
    public void Machine_age_clock_is_view_lifetime_bound_and_does_not_poll_network()
    {
        var code = File.ReadAllText(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/Views/MachineTabView.xaml.cs"));
        Assert.Contains("DispatcherTimer", code);
        Assert.Contains("Unloaded +=", code);
        Assert.Contains("_freshnessTimer.Stop()", code);
        Assert.Contains("RefreshFreshness()", code);
        Assert.DoesNotContain("RefreshCommand", code);
    }

    [Fact]
    public void Cabinet_surfaces_show_exact_last_seen_and_fleet_uses_historical_status()
    {
        foreach (var file in new[] { "CabinetListView.xaml", "CabinetFinderView.xaml", "FleetTabView.xaml" })
        {
            var text = File.ReadAllText(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/Views", file));
            Assert.Contains("Binding LastCheckInExact", text);
        }
        var fleet = File.ReadAllText(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/Views/FleetTabView.xaml"));
        Assert.Contains("Binding DisplayStatus", fleet);
        Assert.DoesNotContain("Content=\"{Binding Status}\"", fleet);
    }

    [Fact]
    public void Finder_routes_have_native_keyboard_and_mouse_open_buttons()
    {
        var xaml = XDocument.Load(Path.Combine(ProjectRoot, "src/CabinetPlatform.Console/Views/CabinetFinderView.xaml"));
        var buttons = xaml.Descendants().Where(e => e.Name.LocalName == "Button" &&
            ((string?)e.Attribute("Command"))?.Contains("ChooseCommand") == true).ToList();
        Assert.Equal(3, buttons.Count);
        Assert.All(buttons, button => Assert.NotNull(button.Attribute("CommandParameter")));
    }

    private static readonly Regex BindingPath = new(
        @"\{Binding\s+(?:Path=)?(?<path>[A-Za-z_][A-Za-z0-9_.\[\]]*)",
        RegexOptions.Compiled);

    private static readonly Regex ResourceKey = new(
        @"\{(?:Static|Dynamic)Resource\s+(?<key>[A-Za-z0-9_.]+)\s*\}",
        RegexOptions.Compiled);

    /// <summary>
    /// Binding-path roots that are not ViewModel members: WPF's own properties,
    /// reached through RelativeSource or a templated parent.
    /// </summary>
    private static readonly HashSet<string> FrameworkPaths = new(StringComparer.Ordinal)
    {
        // WPF's own properties, reached through RelativeSource or a template.
        "Content", "DataContext", "IsChecked", "SelectedItem", "Text",

        // Binding keywords the expression syntax puts where a path would go.
        "ElementName", "RelativeSource", "Source", "Mode", "Converter",
        "ConverterParameter", "StringFormat", "UpdateSourceTrigger"
    };

    private static string ProjectRoot
    {
        get
        {
            DirectoryInfo? directory = new(AppContext.BaseDirectory);

            while (directory is not null &&
                   !File.Exists(Path.Combine(directory.FullName, "CabinetPlatform.sln")))
            {
                directory = directory.Parent;
            }

            Assert.NotNull(directory);
            return directory!.FullName;
        }
    }

    private static IReadOnlyList<string> XamlFiles =>
        Directory.GetFiles(
                Path.Combine(ProjectRoot, "src", "CabinetPlatform.Console"),
                "*.xaml",
                SearchOption.AllDirectories)
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void The_wpf_project_has_markup_to_check()
    {
        // Guards the tests below from passing vacuously if the project moves.
        Assert.True(XamlFiles.Count >= 12, $"found only {XamlFiles.Count} XAML files");
    }

    [Fact]
    public void Every_xaml_file_is_well_formed()
    {
        foreach (string file in XamlFiles)
        {
            try
            {
                XDocument.Load(file);
            }
            catch (Exception ex)
            {
                Assert.Fail($"{Path.GetFileName(file)} is not well-formed XML: {ex.Message}");
            }
        }
    }

    /// <summary>
    /// Every resource key the markup asks for is defined by one of its own
    /// dictionaries, or is a WPF system resource.
    /// </summary>
    [Fact]
    public void Every_resource_key_referenced_is_defined()
    {
        HashSet<string> defined = new(StringComparer.Ordinal);

        foreach (string file in XamlFiles)
        {
            foreach (XElement element in XDocument.Load(file).Descendants())
            {
                XAttribute? key = element.Attributes()
                    .FirstOrDefault(a => a.Name.LocalName == "Key");

                if (key is not null)
                {
                    defined.Add(key.Value);
                }
            }
        }

        List<string> missing = new();

        foreach (string file in XamlFiles)
        {
            string text = File.ReadAllText(file);

            foreach (Match match in ResourceKey.Matches(text))
            {
                string referenced = match.Groups["key"].Value;

                // SystemColors and SystemParameters resources come from WPF.
                if (referenced.StartsWith("System", StringComparison.Ordinal))
                {
                    continue;
                }

                if (!defined.Contains(referenced))
                {
                    missing.Add($"{Path.GetFileName(file)} references undefined resource '{referenced}'");
                }
            }
        }

        Assert.Empty(missing.Distinct());
    }

    /// <summary>
    /// Every binding path's first segment names a real public member somewhere
    /// in the Core assembly.
    /// </summary>
    /// <remarks>
    /// Deliberately a loose check: it does not know which DataContext each
    /// element sits under, so it cannot catch a path that is real but bound in
    /// the wrong place. What it does catch is the typo and the stale rename —
    /// a binding to <c>Summarise</c> after the property became
    /// <c>SummaryText</c>, which is exactly the failure this test was written
    /// after finding.
    /// </remarks>
    [Fact]
    public void Every_binding_path_names_a_real_member_of_the_core_assembly()
    {
        Assembly core = typeof(StatusPresentation).Assembly;

        // Contracts too: a section that holds a list of contract records — the
        // network adapters, the installed software — binds a grid column
        // straight at those records rather than wrapping each one in a row type
        // that would add nothing.
        Assembly contracts = typeof(Contracts.Telemetry.NetworkAdapterInfo).Assembly;

        HashSet<string> members = new(StringComparer.Ordinal);

        foreach (Type type in core.GetExportedTypes().Concat(contracts.GetExportedTypes()))
        {
            foreach (MemberInfo member in type.GetMembers(
                         BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static))
            {
                members.Add(member.Name);
            }
        }

        List<string> unknown = new();

        foreach (string file in XamlFiles)
        {
            string text = File.ReadAllText(file);

            foreach (Match match in BindingPath.Matches(text))
            {
                string path = match.Groups["path"].Value;

                // Only the first segment: the rest walks into types this check
                // has no way to resolve without knowing the DataContext.
                string root = path.Split('.', '[')[0];

                if (root.Length == 0 || FrameworkPaths.Contains(root) || members.Contains(root))
                {
                    continue;
                }

                unknown.Add($"{Path.GetFileName(file)} binds to '{path}', and no public member " +
                            $"named '{root}' exists in {core.GetName().Name} or " +
                            $"{contracts.GetName().Name}");
            }
        }

        Assert.Empty(unknown.Distinct());
    }

    /// <summary>
    /// Every <c>Command="{Binding XCommand}"</c> names a command property that
    /// the MVVM generator actually produced.
    /// </summary>
    [Fact]
    public void Every_bound_command_exists_on_a_view_model()
    {
        Assembly core = typeof(StatusPresentation).Assembly;

        HashSet<string> commands = new(StringComparer.Ordinal);

        foreach (Type type in core.GetExportedTypes())
        {
            foreach (PropertyInfo property in type.GetProperties(
                         BindingFlags.Public | BindingFlags.Instance))
            {
                if (property.Name.EndsWith("Command", StringComparison.Ordinal))
                {
                    commands.Add(property.Name);
                }
            }
        }

        List<string> missing = new();

        var commandBinding = new Regex(
            @"Command\s*=\s*""\{Binding\s+(?<name>[A-Za-z0-9_]+Command)\s*\}""",
            RegexOptions.Compiled);

        foreach (string file in XamlFiles)
        {
            foreach (Match match in commandBinding.Matches(File.ReadAllText(file)))
            {
                string name = match.Groups["name"].Value;

                if (!commands.Contains(name))
                {
                    missing.Add($"{Path.GetFileName(file)} binds Command to '{name}', " +
                                "which no ViewModel exposes");
                }
            }
        }

        Assert.Empty(missing.Distinct());
    }

    /// <summary>
    /// Every interactive control carries an accessible name.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the accessibility requirement that decays fastest, because a
    /// control added in a hurry works perfectly well for a sighted mouse user
    /// and is a dead end for everyone else. Asserting it in a test is the only
    /// way it stays true.
    /// </para>
    /// <para>
    /// A control is considered named if it has an explicit
    /// <c>AutomationProperties.Name</c>, or literal text content that WPF will
    /// use as its name, or is marked as not part of the accessibility tree.
    /// </para>
    /// </remarks>
    [Fact]
    public void Every_interactive_control_has_an_accessible_name()
    {
        string[] interactive =
        {
            "Button", "CheckBox", "RadioButton", "TextBox", "PasswordBox",
            "ComboBox", "DatePicker", "DataGrid", "GridSplitter", "Slider", "ToggleButton"
        };

        List<string> unnamed = new();

        foreach (string file in XamlFiles)
        {
            foreach (XElement element in XDocument.Load(file).Descendants())
            {
                if (!interactive.Contains(element.Name.LocalName))
                {
                    continue;
                }

                if (HasAttribute(element, "AutomationProperties.Name") ||
                    HasAttribute(element, "AutomationProperties.AccessibilityView"))
                {
                    continue;
                }

                // A Button whose Content is literal text is named by that text.
                if (element.Name.LocalName is "Button" or "CheckBox" or "RadioButton" &&
                    HasAttribute(element, "Content"))
                {
                    continue;
                }

                unnamed.Add($"{Path.GetFileName(file)}: <{element.Name.LocalName}> has no " +
                            "AutomationProperties.Name");
            }
        }

        Assert.Empty(unnamed);
    }

    /// <summary>
    /// No confirmation dialog makes its confirm button the default.
    /// </summary>
    /// <remarks>
    /// A dialog whose confirm button is <c>IsDefault</c> turns a Return
    /// keystroke the user was already pressing into consent. For a reboot on a
    /// cabinet mid-dispense that is not a hypothetical cost, so the dialogs
    /// place focus on Cancel and leave Return doing nothing.
    /// </remarks>
    [Fact]
    public void Dialogs_do_not_make_their_confirm_button_the_default()
    {
        foreach (string file in XamlFiles.Where(f =>
                     Path.GetFileName(f).Contains("Dialog", StringComparison.Ordinal)))
        {
            XDocument document = XDocument.Load(file);

            List<XElement> buttons = document.Descendants()
                .Where(e => e.Name.LocalName == "Button")
                .ToList();

            Assert.DoesNotContain(buttons, b =>
                string.Equals(b.Attribute("IsDefault")?.Value, "True", StringComparison.OrdinalIgnoreCase));

            // And one button holds initial focus, so focus placement is not left
            // to whatever the window happens to tab to first.
            Assert.Contains(buttons, b => b.Attributes()
                .Any(a => a.Name.LocalName == "FocusBehaviour.FocusOnLoad" &&
                          string.Equals(a.Value, "True", StringComparison.OrdinalIgnoreCase)));

            // The button that holds focus is the cancel button.
            XElement focused = buttons.First(b => b.Attributes()
                .Any(a => a.Name.LocalName == "FocusBehaviour.FocusOnLoad"));

            Assert.Equal("True", focused.Attribute("IsCancel")?.Value);
        }
    }

    /// <summary>
    /// Every DataGrid renders through the shared style, which is what attaches
    /// column-header and row automation names.
    /// </summary>
    [Fact]
    public void Every_data_grid_uses_the_accessible_style()
    {
        // Styles that reach AccessibleDataGrid, directly or through BasedOn. A
        // derived style is fine: it inherits the header and row automation
        // names, which is the property being protected here.
        HashSet<string> accessible = new(StringComparer.Ordinal) { "AccessibleDataGrid" };

        Dictionary<string, string> basedOn = new(StringComparer.Ordinal);

        foreach (string file in XamlFiles)
        {
            foreach (XElement style in XDocument.Load(file)
                         .Descendants()
                         .Where(e => e.Name.LocalName == "Style"))
            {
                string? key = style.Attributes()
                    .FirstOrDefault(a => a.Name.LocalName == "Key")?.Value;

                string? parent = style.Attribute("BasedOn")?.Value;

                if (key is not null && parent is not null)
                {
                    basedOn[key] = ExtractResourceKey(parent);
                }
            }
        }

        // Transitive closure: keep pulling in styles whose parent is already
        // known to be accessible until nothing new appears.
        bool grew = true;

        while (grew)
        {
            grew = false;

            foreach ((string key, string parent) in basedOn)
            {
                if (!accessible.Contains(key) && accessible.Contains(parent))
                {
                    accessible.Add(key);
                    grew = true;
                }
            }
        }

        List<string> offenders = new();

        foreach (string file in XamlFiles)
        {
            foreach (XElement grid in XDocument.Load(file)
                         .Descendants()
                         .Where(e => e.Name.LocalName == "DataGrid"))
            {
                string? style = grid.Attribute("Style")?.Value;

                if (style is null || !accessible.Contains(ExtractResourceKey(style)))
                {
                    offenders.Add($"{Path.GetFileName(file)}: a DataGrid uses " +
                                  $"'{style ?? "no style"}', which does not derive from " +
                                  "AccessibleDataGrid");
                }
            }
        }

        Assert.Empty(offenders);
    }

    /// <summary>Pulls the key out of a <c>{StaticResource Key}</c> expression.</summary>
    private static string ExtractResourceKey(string expression)
    {
        Match match = ResourceKey.Match(expression);
        return match.Success ? match.Groups["key"].Value : expression.Trim();
    }

    /// <summary>
    /// There is no free-text command, script or query input anywhere in the UI.
    /// </summary>
    /// <remarks>
    /// The product rule is that no such field exists, at any role. A rule of
    /// that kind is worth a test rather than a comment: it is one hurried commit
    /// away from being broken, and the commit that breaks it will look helpful.
    /// </remarks>
    [Fact]
    public void No_input_control_invites_a_command_script_or_query()
    {
        string[] forbidden =
        {
            "command", "script", "powershell", "cmd", "shell",
            "sql", "query text", "run this", "execute"
        };

        List<string> offenders = new();

        foreach (string file in XamlFiles)
        {
            foreach (XElement element in XDocument.Load(file).Descendants())
            {
                if (element.Name.LocalName is not ("TextBox" or "RichTextBox"))
                {
                    continue;
                }

                string described = string.Join(
                    " ",
                    element.Attributes()
                        .Where(a => a.Name.LocalName is "AutomationProperties.Name"
                            or "AutomationProperties.HelpText" or "Text" or "Tag")
                        .Select(a => a.Value))
                    .ToLowerInvariant();

                foreach (string word in forbidden)
                {
                    if (described.Contains(word, StringComparison.Ordinal))
                    {
                        offenders.Add($"{Path.GetFileName(file)}: a text input mentions '{word}'");
                    }
                }
            }
        }

        Assert.Empty(offenders);
    }

    private static bool HasAttribute(XElement element, string name) =>
        element.Attributes().Any(a => string.Equals(a.Name.LocalName, name, StringComparison.Ordinal));
}
