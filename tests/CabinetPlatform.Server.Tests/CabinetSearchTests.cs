using System.Net;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// Finding the right cabinet, and saying unambiguously which one was found.
/// </summary>
/// <remarks>
/// With three and a half thousand client organisations and seven thousand
/// cabinets, picking the wrong cabinet is the most likely serious operator
/// error this product has. These tests are about the two halves of preventing
/// it: a search that finds what a rep actually has to hand, and a result that
/// identifies what it found.
/// </remarks>
public sealed class CabinetSearchTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public CabinetSearchTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Every_result_carries_the_full_path_and_never_a_bare_hostname()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("finder"));

        string suffix = Unique("pathtest");

        await TestClient.CreateApprovedCabinetAsync(
            _factory,
            $"m-{suffix}",
            user.Id,
            clientName: $"Riverside Veterinary {suffix}",
            siteName: "Branch Surgery",
            role: CabinetRole.Sync);

        PagedResult<CabinetSearchHit> results = await SearchAsync(client, $"Riverside Veterinary {suffix}");

        CabinetSearchHit hit = Assert.Single(results.Items);

        Assert.Equal($"Riverside Veterinary {suffix}", hit.Path.ClientName);
        Assert.Equal("Branch Surgery", hit.Path.SiteName);
        Assert.Equal("Pharmacy", hit.Path.DepartmentName);
        Assert.Equal($"host-m-{suffix}", hit.Path.CabinetName);
        Assert.Equal(CabinetRole.Sync, hit.Path.Role);

        // The one-line rendering contains every part, in order, so a console
        // with room for only one string still identifies the cabinet.
        Assert.Contains($"Riverside Veterinary {suffix}", hit.Path.Display, StringComparison.Ordinal);
        Assert.Contains("Branch Surgery", hit.Path.Display, StringComparison.Ordinal);
        Assert.Contains("Pharmacy", hit.Path.Display, StringComparison.Ordinal);
        Assert.Contains($"host-m-{suffix}", hit.Path.Display, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(CabinetSearchMatch.ClientName)]
    [InlineData(CabinetSearchMatch.SiteName)]
    [InlineData(CabinetSearchMatch.Department)]
    [InlineData(CabinetSearchMatch.Hostname)]
    [InlineData(CabinetSearchMatch.SerialNumber)]
    public async Task One_term_matches_across_every_identifying_column(CabinetSearchMatch field)
    {
        // A rep does not know in advance which kind of thing they are holding:
        // the client who rang, the site they named, the sticker on the cabinet,
        // or the serial number underneath it. Making them pick a field first is
        // asking a question they cannot answer.
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("cols"));

        string suffix = Unique("col").Replace("-", string.Empty);

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory,
            $"m-{suffix}",
            user.Id,
            clientName: $"Clientname{suffix}",
            siteName: $"Sitename{suffix}");

        await _factory.WithDbAsync(async db =>
        {
            Cabinet stored = await db.Cabinets.FirstAsync(c => c.Id == cabinet.Id);
            stored.DepartmentName = $"Deptname{suffix}";
            stored.SerialNumber = $"Serial{suffix}";
            await db.SaveChangesAsync();
            return stored;
        });

        string term = field switch
        {
            CabinetSearchMatch.ClientName => $"Clientname{suffix}",
            CabinetSearchMatch.SiteName => $"Sitename{suffix}",
            CabinetSearchMatch.Department => $"Deptname{suffix}",
            CabinetSearchMatch.Hostname => $"host-m-{suffix}",
            _ => $"Serial{suffix}",
        };

        PagedResult<CabinetSearchHit> results = await SearchAsync(client, term);

        CabinetSearchHit hit = Assert.Single(results.Items);
        Assert.Equal(cabinet.Id, hit.Cabinet.Id);

        // And the result says which field matched, so a serial-number hit on a
        // row whose name looks unrelated is not baffling.
        Assert.Equal(field, hit.MatchedOn);
    }

    [Fact]
    public async Task A_cabinet_id_pasted_from_a_ticket_finds_exactly_that_cabinet()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("byid"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: $"IdClient {Unique("c")}");

        PagedResult<CabinetSearchHit> results = await SearchAsync(client, cabinet.Id.ToString());

        CabinetSearchHit hit = Assert.Single(results.Items);
        Assert.Equal(cabinet.Id, hit.Cabinet.Id);
        Assert.Equal(CabinetSearchMatch.CabinetId, hit.MatchedOn);
    }

    [Fact]
    public async Task Matching_is_partial_and_ignores_case()
    {
        // Partial matches are most of what reps have: "Riverside" for
        // "Riverside Veterinary Group", typed while somebody talks at them.
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("partial"));

        string suffix = Unique("pm").Replace("-", string.Empty);

        await TestClient.CreateApprovedCabinetAsync(
            _factory, $"m-{suffix}", user.Id, clientName: $"Northgate Veterinary {suffix}");

        PagedResult<CabinetSearchHit> results = await SearchAsync(client, $"nOrThGaTe vEtErInArY {suffix}");

        Assert.NotEmpty(results.Items);
    }

    [Fact]
    public async Task Two_cabinets_with_one_name_in_a_result_set_are_both_flagged()
    {
        // This is the mistake the whole feature exists to prevent. CUBEX01 is a
        // name hundreds of clients have chosen independently; two of them in
        // front of a rep at once is where the wrong cabinet gets picked.
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("dupes"));

        string shared = "CUBEX01-" + Unique("s").Replace("-", string.Empty);

        Cabinet first = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m1"), user.Id, clientName: $"First Client {shared}");

        Cabinet second = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m2"), user.Id, clientName: $"Second Client {shared}");

        await _factory.WithDbAsync(async db =>
        {
            foreach (Guid id in new[] { first.Id, second.Id })
            {
                Cabinet stored = await db.Cabinets.FirstAsync(c => c.Id == id);
                stored.Hostname = shared;
            }

            await db.SaveChangesAsync();
            return 0;
        });

        PagedResult<CabinetSearchHit> results = await SearchAsync(client, shared);

        Assert.Equal(2, results.Items.Count);
        Assert.All(results.Items, hit => Assert.True(hit.Path.HostnameIsAmbiguous));

        // And each is still distinguishable, because the client is on the row.
        Assert.Equal(2, results.Items.Select(h => h.Path.ClientName).Distinct().Count());
    }

    [Fact]
    public async Task A_unique_name_in_a_result_set_is_not_flagged()
    {
        // The warning has to mean something. Flagging every row would train
        // reps to ignore it.
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("unique"));

        string suffix = Unique("uq").Replace("-", string.Empty);

        await TestClient.CreateApprovedCabinetAsync(
            _factory, $"m-{suffix}", user.Id, clientName: $"Unique Client {suffix}");

        PagedResult<CabinetSearchHit> results = await SearchAsync(client, $"Unique Client {suffix}");

        Assert.All(results.Items, hit => Assert.False(hit.Path.HostnameIsAmbiguous));
    }

    [Fact]
    public async Task A_page_size_above_the_servers_ceiling_is_clamped_rather_than_served()
    {
        (HttpClient client, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("page"));

        PagedResult<CabinetSearchHit>? results =
            await (await client.GetAsync("/api/search/cabinets?term=&pageSize=100000"))
                .ReadAsync<PagedResult<CabinetSearchHit>>();

        Assert.NotNull(results);
        Assert.Equal(PagedQuery.MaxPageSize, results!.PageSize);
    }

    [Fact]
    public async Task A_search_is_recorded_as_an_observation()
    {
        // Reading is Observed, never Caused. It is still recorded: with no case
        // scoping and no per-rep assignment, the trail of what was looked for
        // is the control that replaces them.
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("audited"));

        await SearchAsync(client, Unique("nothing-matches-this"));

        Domain.AuditEntry entry = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.SearchCabinets && a.ActorId == user.Id.ToString())
            .FirstAsync());

        Assert.Equal(AuditEventKind.Observed, entry.EventKind);
        Assert.Equal(AuditResult.Success, entry.Result);
    }

    [Fact]
    public async Task Opening_a_cabinet_puts_it_at_the_top_of_that_reps_recent_list_and_nobody_elses()
    {
        (HttpClient mine, User me) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("mine"));

        (HttpClient theirs, _) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("theirs"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), me.Id, clientName: $"Recent Client {Unique("c")}");

        Assert.Equal(HttpStatusCode.OK, (await mine.GetAsync($"/api/cabinets/{cabinet.Id}")).StatusCode);

        IReadOnlyList<RecentCabinetDto>? recent =
            await (await mine.GetAsync("/api/search/recent")).ReadAsync<IReadOnlyList<RecentCabinetDto>>();

        Assert.NotNull(recent);
        Assert.Contains(recent!, r => r.Path.CabinetId == cabinet.Id);

        // The list is per rep. Nobody can ask for somebody else's, and nobody's
        // reading shows up in anybody else's.
        IReadOnlyList<RecentCabinetDto>? other =
            await (await theirs.GetAsync("/api/search/recent")).ReadAsync<IReadOnlyList<RecentCabinetDto>>();

        Assert.NotNull(other);
        Assert.DoesNotContain(other!, r => r.Path.CabinetId == cabinet.Id);
    }

    [Fact]
    public async Task The_hierarchy_lists_a_clients_sites_with_the_sync_cabinet_first()
    {
        // A site that misbehaves as a whole is usually its sync cabinet, and a
        // rep should not have to find it among twenty rows.
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Unique("hier"));

        string clientName = $"Hierarchy Client {Unique("h")}";

        await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("sat1"), user.Id,
            clientName: clientName, siteName: "One Site", role: CabinetRole.Satellite);

        Cabinet sync = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("sync"), user.Id,
            clientName: clientName, siteName: "One Site", role: CabinetRole.Sync);

        Guid clientId = await _factory.WithDbAsync(db => db.Clients
            .AsNoTracking()
            .Where(c => c.Name == clientName)
            .Select(c => c.Id)
            .FirstAsync());

        ClientHierarchyDto? hierarchy =
            await (await client.GetAsync($"/api/search/clients/{clientId}"))
                .ReadAsync<ClientHierarchyDto>();

        Assert.NotNull(hierarchy);
        Assert.Equal(clientName, hierarchy!.Client.Name);

        SiteWithCabinetsDto site = Assert.Single(hierarchy.Sites);
        Assert.Equal(2, site.Cabinets.Count);
        Assert.Equal(sync.Id, site.Cabinets[0].CabinetId);
        Assert.Equal(CabinetRole.Sync, site.Cabinets[0].Role);
    }

    private static async Task<PagedResult<CabinetSearchHit>> SearchAsync(HttpClient client, string term)
    {
        HttpResponseMessage response =
            await client.GetAsync($"/api/search/cabinets?term={Uri.EscapeDataString(term)}&pageSize=50");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        PagedResult<CabinetSearchHit>? results = await response.ReadAsync<PagedResult<CabinetSearchHit>>();
        Assert.NotNull(results);

        return results!;
    }

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
