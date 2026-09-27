using System.Windows.Input;
using System.Xml.Linq;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class FleetNavigationTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;

    public FleetNavigationTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Fleet_site_rows_show_all_filtered_cabinets_and_open_the_bound_identity()
    {
        // Follow the actual template contexts, not just member names somewhere
        // in the assembly. Native WPF layout and input still need Windows QA.
        XDocument view = LoadView("FleetTabView.xaml");
        XElement sites = Assert.Single(view.Descendants(), e =>
            (string?)e.Attribute("ItemsSource") == "{Binding Sites}");
        XElement cabinets = Assert.Single(sites.Descendants(), e =>
            e.Name.LocalName == "DataGrid" &&
            (string?)e.Attribute("ItemsSource") == "{Binding Cabinets}");
        XElement open = Assert.Single(cabinets.Descendants(), e => e.Name.LocalName == "Button");
        Assert.Equal("{Binding DataContext.Finder.ChooseCommand, RelativeSource={RelativeSource AncestorType=Window}}",
            (string?)open.Attribute("Command"));
        Assert.Equal("{Binding Id}", (string?)open.Attribute("CommandParameter"));
        Assert.Equal("{Binding AccessibleSummary}", (string?)open.Attribute("AutomationProperties.Name"));
        Assert.Contains(cabinets.Descendants(), e => (string?)e.Attribute("Binding") == "{Binding ActiveLabel}");
        Assert.Contains(sites.Descendants(), e => (string?)e.Attribute("Text") == "{Binding Headline}");
        Assert.Equal("{Binding Fleet}", (string?)Assert.Single(LoadView("MainWindow.xaml").Descendants(),
            e => e.Name.LocalName == "FleetTabView").Attribute("DataContext"));

        string client = $"Fleet-{Guid.NewGuid():N}";
        Cabinet sync = await _host.CreateCabinetAsync("SAME-NAME", client, "North", role: CabinetRole.Sync);
        Cabinet inactive = await _host.CreateCabinetAsync("RETIRED", client, "North", isActive: false);
        Cabinet otherSite = await _host.CreateCabinetAsync("SAME-NAME", client, "South");
        Cabinet otherClient = await _host.CreateCabinetAsync("SAME-NAME", $"Other-{Guid.NewGuid():N}", "North");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        await _host.AddFullCheckInAsync(sync.Id, TestData.Payload(sync.MachineId, now, pendingUpdates: 0), now);

        ShellViewModel shell = await SignedInShellAsync();
        shell.Fleet.ClientFilter = client;
        shell.Fleet.SiteFilter = "North";
        await shell.Fleet.RefreshCommand.ExecuteAsync(null);
        Assert.Null(shell.Fleet.ErrorMessage);
        SiteGroupRow site = Assert.Single(shell.Fleet.Sites);
        Assert.Equal(new[] { sync.Id, inactive.Id }, site.Cabinets.Select(c => c.Id));
        Assert.DoesNotContain(site.Cabinets, c => c.Id == otherSite.Id || c.Id == otherClient.Id);
        Assert.DoesNotContain(shell.Fleet.StaleCheckIns, c => c.Id == sync.Id);
        Assert.DoesNotContain(shell.Fleet.PendingUpdates, c => c.Id == sync.Id);
        Assert.DoesNotContain(shell.Fleet.DrivesNeedingAttention, c => c.Id == sync.Id);

        // Resolve the exact command path established above on the real window
        // context, and pass the row's Guid rather than its nonunique hostname.
        CabinetRow row = site.Cabinets.Single(c => c.Id == sync.Id);
        ICommand command = shell.Finder.ChooseCommand;
        shell.SelectedTabIndex = 3;
        Assert.True(command.CanExecute(row.Id));
        command.Execute(row.Id);
        await shell.PendingSelectionLoad;
        Assert.Null(shell.Machine.ErrorMessage);
        Assert.Equal(sync.Id, shell.Machine.CabinetId);
        Assert.Equal(ShellView.Cabinets, shell.CurrentView);
        Assert.Equal(0, shell.SelectedTabIndex);
        Assert.Contains(client, shell.Machine.HeaderPath);
        Assert.Contains("North", shell.Machine.HeaderPath);
    }

    [Fact]
    public void Fleet_cabinet_columns_resolve_on_their_actual_row_type()
    {
        XElement sites = Assert.Single(LoadView("FleetTabView.xaml").Descendants(), e =>
            (string?)e.Attribute("ItemsSource") == "{Binding Sites}");
        XElement grid = Assert.Single(sites.Descendants(), e => e.Name.LocalName == "DataGrid");
        XElement[] columns = grid.Descendants().Where(e => e.Name.LocalName == "DataGridTextColumn").ToArray();
        Assert.NotEmpty(columns);
        foreach (XElement column in columns)
        {
            string binding = Assert.IsType<string>((string?)column.Attribute("Binding"));
            Assert.StartsWith("{Binding ", binding);
            string path = binding[9..^1];
            Assert.True(typeof(CabinetRow).GetProperty(path) is not null,
                $"Fleet cabinet column {column.Attribute("Header")} binds missing CabinetRow.{path}");
        }
    }

    [Fact]
    public async Task Truncation_warning_identifies_incomplete_site_groups_and_the_full_lookup_route()
    {
        ShellViewModel shell = await SignedInShellAsync();
        shell.Fleet.WorklistsTruncated = true;
        shell.Fleet.CabinetsExamined = 4000;
        Assert.Contains("site groups", shell.Fleet.TruncationNote);
        Assert.Contains("drive counts", shell.Fleet.TruncationNote);
        Assert.Contains("Find cabinet", shell.Fleet.TruncationNote);
        Assert.Contains(shell.Fleet.CabinetsExamined.ToString("N0"), shell.Fleet.TruncationNote);
        XElement warning = Assert.Single(LoadView("FleetTabView.xaml").Descendants(), e =>
            (string?)e.Attribute("Text") == "{Binding TruncationNote}");
        Assert.Equal("{Binding WorklistsTruncated, Converter={StaticResource BoolToVisibility}}",
            (string?)warning.Parent!.Attribute("Visibility"));
    }

    [Fact]
    public async Task Global_lookup_from_fleet_reaches_a_cabinet_outside_the_site_filter()
    {
        XDocument window = LoadView("MainWindow.xaml");
        XElement search = Assert.Single(window.Descendants(), e => e.Name.LocalName == "TextBox" &&
            e.Attributes().Any(a => a.Name.LocalName == "Name" && a.Value == "GlobalSearchBox"));
        Assert.Equal("{Binding Term, UpdateSourceTrigger=PropertyChanged}", (string?)search.Attribute("Text"));
        Assert.Contains(search.Ancestors(), e => (string?)e.Attribute("DataContext") == "{Binding Finder}");
        Assert.Contains(search.Descendants(), e => e.Name.LocalName == "KeyBinding" &&
            (string?)e.Attribute("Key") == "Return" && (string?)e.Attribute("Command") == "{Binding SearchCommand}");

        string client = $"Lookup-{Guid.NewGuid():N}";
        await _host.CreateCabinetAsync("CAB-SHOWN", client, "North");
        Cabinet target = await _host.CreateCabinetAsync("CAB-TARGET", client, "South");
        ShellViewModel shell = await SignedInShellAsync();
        shell.Fleet.ClientFilter = client;
        shell.Fleet.SiteFilter = "North";
        await shell.Fleet.LoadAsync();
        Assert.DoesNotContain(shell.Fleet.Sites.SelectMany(s => s.Cabinets), c => c.Id == target.Id);

        shell.SelectedTabIndex = 3;
        shell.Finder.Term = target.Id.ToString();
        await shell.Finder.SearchCommand.ExecuteAsync(null);
        Assert.Null(shell.Finder.ErrorMessage);
        Assert.Equal(ShellView.Find, shell.CurrentView);
        Assert.Equal(target.Id, Assert.Single(shell.Finder.Results).Id);
        shell.Finder.ChooseCommand.Execute(target.Id);
        await shell.PendingSelectionLoad;
        Assert.Equal(target.Id, shell.Machine.CabinetId);
        Assert.Null(shell.Machine.ErrorMessage);
        Assert.Equal(0, shell.SelectedTabIndex);

        await shell.Fleet.ClearFiltersCommand.ExecuteAsync(null);
        Assert.Null(shell.Fleet.ErrorMessage);
        Assert.Contains(shell.Fleet.Sites.SelectMany(s => s.Cabinets), c => c.Id == target.Id);
    }

    private async Task<ShellViewModel> SignedInShellAsync()
    {
        string username = $"fleet-{Guid.NewGuid():N}";
        await _host.CreateUserAsync(Role.Tier1, username);
        (ApiClient api, SessionStore session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var announcer = new RecordingLiveRegionAnnouncer();
        TimeProvider time = TimeProvider.System;
        var invoker = new ActionInvoker(api, ScriptedActionDialog.Accepting(), announcer, session);
        return new ShellViewModel(
            new CabinetListViewModel(api, announcer, time),
            new CabinetFinderViewModel(api, announcer, time),
            new MachineTabViewModel(api, invoker, session, announcer, time),
            new CabinetTabViewModel(),
            new AuditTabViewModel(api, announcer, time),
            new FleetTabViewModel(api, announcer, time),
            new ApprovalsViewModel(api, ScriptedApprovalDialog.Accepting(), session, announcer, time),
            new RegistrationsViewModel(api, session, announcer),
            session, announcer, api);
    }

    private static XDocument LoadView(string name)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "CabinetPlatform.sln")))
        {
            directory = directory.Parent;
        }
        Assert.NotNull(directory);
        return XDocument.Load(Path.Combine(directory.FullName, "src/CabinetPlatform.Console/Views", name));
    }
}
