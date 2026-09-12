using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// Finding a cabinet, and being told unambiguously which one was found.
/// </summary>
/// <remarks>
/// Picking the wrong cabinet is the most likely serious operator error this
/// product has. These tests are about what a rep actually sees: the full path
/// on every row, a warning in words when two rows carry one name, and the
/// recent list that makes coming back to a cabinet one click.
/// </remarks>
public sealed class CabinetFinderTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;

    public CabinetFinderTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Every_result_row_shows_the_whole_path_and_not_a_bare_hostname()
    {
        string suffix = Unique("path");

        await _host.CreateCabinetAsync(
            $"CUBEX-{suffix}", client: $"Riverside Veterinary {suffix}", site: "Branch Surgery");

        CabinetFinderViewModel finder = await SignedInFinderAsync();

        finder.Term = $"Riverside Veterinary {suffix}";
        await finder.SearchAsync();

        CabinetSearchRow row = Assert.Single(finder.Results);

        Assert.Equal($"Riverside Veterinary {suffix}", row.ClientName);
        Assert.Equal("Branch Surgery", row.SiteName);
        Assert.Equal("Pharmacy", row.Department);
        Assert.Equal($"CUBEX-{suffix}", row.CabinetName);

        // The single-string rendering a narrow screen would use still carries
        // every part, so there is no layout in which a hostname stands alone.
        Assert.Contains($"Riverside Veterinary {suffix}", row.Display, StringComparison.Ordinal);
        Assert.Contains("Branch Surgery", row.Display, StringComparison.Ordinal);

        // And the sentence a screen reader hears names the client first.
        Assert.StartsWith("Client Riverside Veterinary", row.AccessibleSummary, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Two_rows_with_one_name_are_warned_about_in_words_and_on_the_row()
    {
        // A colour or an icon alone fails for a rep using a screen reader and
        // for one glancing at a grid, and those are the two people most likely
        // to pick the wrong row.
        string shared = $"CUBEX01-{Unique("d")}";

        await _host.CreateCabinetAsync(shared, client: $"First Client {shared}");
        await _host.CreateCabinetAsync(shared, client: $"Second Client {shared}");

        CabinetFinderViewModel finder = await SignedInFinderAsync();

        finder.Term = shared;
        await finder.SearchAsync();

        Assert.Equal(2, finder.Results.Count);
        Assert.True(finder.ResultsContainDuplicateNames);
        Assert.NotNull(finder.DuplicateNameWarning);

        Assert.All(finder.Results, row =>
        {
            Assert.True(row.HasDuplicateName);
            Assert.Equal(CabinetIdentity.AmbiguityMarker, row.DuplicateNameMarker);
            Assert.Contains("same name", row.AccessibleSummary, StringComparison.OrdinalIgnoreCase);
        });

        // Each is still distinguishable, because the client is on the row.
        Assert.Equal(2, finder.Results.Select(r => r.ClientName).Distinct().Count());
    }

    [Fact]
    public async Task A_unique_name_carries_no_warning()
    {
        // The warning has to mean something. Marking every row would train reps
        // to ignore it.
        string suffix = Unique("uq");

        await _host.CreateCabinetAsync($"CUBEX-{suffix}", client: $"Unique Client {suffix}");

        CabinetFinderViewModel finder = await SignedInFinderAsync();

        finder.Term = $"Unique Client {suffix}";
        await finder.SearchAsync();

        Assert.False(finder.ResultsContainDuplicateNames);
        Assert.Null(finder.DuplicateNameWarning);
        Assert.All(finder.Results, row => Assert.Empty(row.DuplicateNameMarker));
    }

    [Fact]
    public async Task A_search_that_matches_nothing_says_so_rather_than_showing_an_empty_grid()
    {
        // An empty grid and a cabinet with nothing to report look the same, and
        // only one of them means the rep should try a different term.
        CabinetFinderViewModel finder = await SignedInFinderAsync();

        finder.Term = Unique("matches-nothing");
        await finder.SearchAsync();

        Assert.Empty(finder.Results);
        Assert.Contains("Nothing matches", finder.ResultSummary, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_empty_search_box_invites_a_term_rather_than_reporting_no_results()
    {
        CabinetFinderViewModel finder = await SignedInFinderAsync();

        Assert.Contains("Type a client", finder.ResultSummary, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Choosing_a_result_raises_the_cabinet_for_the_shell_to_open()
    {
        string suffix = Unique("choose");

        Cabinet cabinet = await _host.CreateCabinetAsync(
            $"CUBEX-{suffix}", client: $"Choose Client {suffix}");

        CabinetFinderViewModel finder = await SignedInFinderAsync();

        var chosen = new List<Guid>();
        finder.CabinetChosen += (_, id) => chosen.Add(id);

        finder.Choose(cabinet.Id);

        Assert.Equal(new[] { cabinet.Id }, chosen);
    }

    [Fact]
    public async Task Opening_a_cabinet_puts_it_in_this_reps_recent_list()
    {
        // Per rep and held by the server, so it follows them between machines
        // and survives a client restart in the middle of a call.
        string suffix = Unique("recent");

        Cabinet cabinet = await _host.CreateCabinetAsync(
            $"CUBEX-{suffix}", client: $"Recent Client {suffix}");

        (ApiClient api, SessionStore session, RecordingLiveRegionAnnouncer announcer) =
            await SignedInAsync();

        // Reading a cabinet's detail is what puts it there, server-side.
        await api.GetCabinetLatestAsync(cabinet.Id, CancellationToken.None);

        var finder = new CabinetFinderViewModel(api, announcer, TimeProvider.System);
        await finder.LoadRecentAsync();

        RecentCabinetRow row = Assert.Single(finder.Recent, r => r.Id == cabinet.Id);

        // The recent list identifies a cabinet the same way everything else
        // does: by its whole path.
        Assert.Contains($"Recent Client {suffix}", row.Display, StringComparison.Ordinal);

        _ = session;
    }

    [Fact]
    public async Task The_hierarchy_lists_a_clients_sites_with_the_sync_cabinet_first()
    {
        // A site that misbehaves as a whole is usually its sync cabinet, and a
        // rep should not have to find it among twenty rows.
        string suffix = Unique("hier");
        string clientName = $"Hierarchy Client {suffix}";

        await _host.CreateCabinetAsync(
            $"SAT-{suffix}", client: clientName, site: "One Site", role: CabinetRole.Satellite);

        Cabinet sync = await _host.CreateCabinetAsync(
            $"SYNC-{suffix}", client: clientName, site: "One Site", role: CabinetRole.Sync);

        CabinetFinderViewModel finder = await SignedInFinderAsync();
        await finder.LoadClientsAsync();

        ClientSummary client = Assert.Single(finder.Clients, c => c.Name == clientName);

        await finder.LoadHierarchyAsync(client.Id);

        SiteWithCabinetsDto site = Assert.Single(finder.HierarchySites);

        Assert.Equal(sync.Id, site.Cabinets[0].CabinetId);
        Assert.Equal(CabinetRole.Sync, site.Cabinets[0].Role);
    }

    [Fact]
    public async Task Clearing_the_search_empties_the_results_rather_than_leaving_them_stale()
    {
        // Stale results under a cleared box is the shape of a rep acting on the
        // previous client's cabinet.
        string suffix = Unique("clear");

        await _host.CreateCabinetAsync($"CUBEX-{suffix}", client: $"Clear Client {suffix}");

        CabinetFinderViewModel finder = await SignedInFinderAsync();

        finder.Term = $"Clear Client {suffix}";
        await finder.SearchAsync();

        Assert.NotEmpty(finder.Results);

        finder.ClearSearch();

        Assert.Empty(finder.Results);
        Assert.Empty(finder.Term);
        Assert.Null(finder.SelectedResult);
    }

    private async Task<CabinetFinderViewModel> SignedInFinderAsync()
    {
        (ApiClient api, _, RecordingLiveRegionAnnouncer announcer) = await SignedInAsync();

        return new CabinetFinderViewModel(api, announcer, TimeProvider.System);
    }

    private async Task<(ApiClient Api, SessionStore Session, RecordingLiveRegionAnnouncer Announcer)>
        SignedInAsync()
    {
        string username = Unique("finder");
        await _host.CreateUserAsync(Role.Tier1, username);

        (ApiClient api, SessionStore session) = _host.CreateConsole();

        await api.LoginAsync(
            new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword },
            CancellationToken.None);

        return (api, session, new RecordingLiveRegionAnnouncer());
    }

    private static string Unique(string prefix) => $"{prefix}{Guid.NewGuid():N}"[..16];
}
