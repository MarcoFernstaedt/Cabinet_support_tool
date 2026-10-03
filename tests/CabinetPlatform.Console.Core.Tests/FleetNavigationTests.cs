using System.Windows.Input;
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

        // Pass the row's Guid rather than its nonunique hostname.
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
    public async Task Truncation_warning_identifies_incomplete_site_groups_and_the_full_lookup_route()
    {
        ShellViewModel shell = await SignedInShellAsync();
        shell.Fleet.WorklistsTruncated = true;
        shell.Fleet.CabinetsExamined = 4000;
        Assert.Contains("site groups", shell.Fleet.TruncationNote);
        Assert.Contains("drive counts", shell.Fleet.TruncationNote);
        Assert.Contains("Find cabinet", shell.Fleet.TruncationNote);
        Assert.Contains(shell.Fleet.CabinetsExamined.ToString("N0"), shell.Fleet.TruncationNote);
    }

    [Fact]
    public async Task Global_lookup_from_fleet_reaches_a_cabinet_outside_the_site_filter()
    {
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
}
