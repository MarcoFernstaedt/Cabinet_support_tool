using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// A cabinet's place in its site, and whether it can actually reach the cabinet
/// its site syncs against.
/// </summary>
/// <remarks>
/// <para>
/// The question a rep has when a whole clinic misbehaves is not "is the sync
/// cabinet up" — the fleet view answers that — but "can this satellite reach
/// it". The two are different facts, and only the second explains the site: a
/// sync cabinet can be perfectly reachable from the server and unreachable from
/// the machine standing next to it.
/// </para>
/// <para>
/// So the console never infers reachability from the sync cabinet being online.
/// Either a probe has been run from this cabinet, or the view says none has.
/// </para>
/// </remarks>
public sealed class TopologyTests
{
    private static readonly DateTimeOffset Now = new(2026, 3, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_satellite_shows_its_sync_cabinet_and_the_last_probe_from_this_cabinet()
    {
        var overview = new OverviewSectionViewModel();

        overview.Apply(
            Detail(
                CabinetRole.Satellite,
                link: new SyncCabinetLinkDto
                {
                    SyncCabinetId = Guid.NewGuid(),
                    SyncCabinetHostname = "CUBEX-SYNC-01",
                    SyncCabinetHealth = CabinetHealthStatus.Healthy,
                    LastProbeReachable = true,
                    LastProbeUtc = Now.AddMinutes(-6),
                    LastProbeLatencyMs = 3.4,
                }),
            Now);

        Assert.Contains("Satellite", overview.Role, StringComparison.Ordinal);
        Assert.Contains("CUBEX-SYNC-01", overview.SyncCabinet, StringComparison.Ordinal);
        Assert.Equal("Reachable", overview.SyncLink.Label);
        Assert.Contains("3 ms", overview.SyncLinkDetail, StringComparison.Ordinal);
        Assert.True(overview.CanTestSyncLink);
    }

    [Fact]
    public void An_unreachable_sync_cabinet_says_which_fact_it_is_reporting()
    {
        var overview = new OverviewSectionViewModel();

        overview.Apply(
            Detail(
                CabinetRole.Satellite,
                link: new SyncCabinetLinkDto
                {
                    SyncCabinetId = Guid.NewGuid(),
                    SyncCabinetHostname = "CUBEX-SYNC-01",

                    // The sync cabinet itself is perfectly healthy from the
                    // server's point of view. That is the trap: this cabinet
                    // still cannot reach it.
                    SyncCabinetHealth = CabinetHealthStatus.Healthy,
                    LastProbeReachable = false,
                    LastProbeUtc = Now.AddMinutes(-4),
                }),
            Now);

        Assert.Equal("Unreachable", overview.SyncLink.Label);
        Assert.Equal(StatusSeverity.Critical, overview.SyncLink.Severity);
        Assert.Contains(
            "different fact from the sync cabinet being offline",
            overview.SyncLinkDetail,
            StringComparison.Ordinal);
    }

    [Fact]
    public void No_probe_reads_as_unknown_and_never_as_reachable()
    {
        // The failure this guards against is the tempting inference: the sync
        // cabinet is online, therefore the satellite can reach it. It cannot be
        // known without asking the satellite.
        var overview = new OverviewSectionViewModel();

        overview.Apply(
            Detail(
                CabinetRole.Satellite,
                link: new SyncCabinetLinkDto
                {
                    SyncCabinetId = Guid.NewGuid(),
                    SyncCabinetHostname = "CUBEX-SYNC-01",
                    SyncCabinetHealth = CabinetHealthStatus.Healthy,
                    LastProbeReachable = null,
                }),
            Now);

        Assert.Equal(StatusSeverity.Unknown, overview.SyncLink.Severity);
        Assert.Contains("No probe has been run", overview.SyncLinkDetail, StringComparison.Ordinal);
        Assert.Contains("not implied by it being online", overview.SyncLinkDetail, StringComparison.Ordinal);

        // Still worth offering the test: that is exactly the cabinet to run it on.
        Assert.True(overview.CanTestSyncLink);
    }

    [Fact]
    public void A_sync_cabinet_does_not_offer_to_probe_itself()
    {
        var overview = new OverviewSectionViewModel();

        overview.Apply(Detail(CabinetRole.Sync, link: null, syncCabinetId: Guid.NewGuid()), Now);

        Assert.Contains("Sync cabinet", overview.Role, StringComparison.Ordinal);
        Assert.False(overview.CanTestSyncLink);
        Assert.Contains("does not probe itself", overview.SyncLinkDetail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_standalone_site_says_it_has_no_link_rather_than_showing_an_empty_one()
    {
        // Ruling 14: a site with no sync cabinet is supported and is not an
        // error. Blank fields would read as a fault.
        var overview = new OverviewSectionViewModel();

        overview.Apply(Detail(CabinetRole.Standalone, link: null, syncCabinetId: null), Now);

        Assert.Contains("Standalone", overview.Role, StringComparison.Ordinal);
        Assert.Equal("This site has no sync cabinet.", overview.SyncCabinet);
        Assert.Contains("no link to test", overview.SyncLinkDetail, StringComparison.Ordinal);
        Assert.False(overview.CanTestSyncLink);
    }

    [Fact]
    public void The_fleet_view_groups_by_site_with_the_sync_cabinet_first()
    {
        Guid siteId = Guid.NewGuid();

        var group = new SiteGroupRow(
            new[]
            {
                Summary("CAB-SAT-02", siteId, CabinetRole.Satellite),
                Summary("CAB-SYNC-01", siteId, CabinetRole.Sync),
                Summary("CAB-SAT-01", siteId, CabinetRole.Satellite),
            },
            Now);

        // The sync cabinet leads, then the rest alphabetically. A reader who
        // scans only the first row of each site has still read the row whose
        // failure explains the others.
        Assert.Equal(
            new[] { "CAB-SYNC-01", "CAB-SAT-01", "CAB-SAT-02" },
            group.Cabinets.Select(c => c.Hostname));

        Assert.Equal("CAB-SYNC-01", group.SyncCabinet!.Hostname);
        Assert.Equal(3, group.CabinetCount);
        Assert.Contains("synced by CAB-SYNC-01", group.Headline, StringComparison.Ordinal);
    }

    [Fact]
    public void A_site_whose_sync_cabinet_is_down_says_the_whole_site_may_be_out_of_step()
    {
        Guid siteId = Guid.NewGuid();

        var group = new SiteGroupRow(
            new[]
            {
                Summary("CAB-SYNC-01", siteId, CabinetRole.Sync, CabinetHealthStatus.Offline),
                Summary("CAB-SAT-01", siteId, CabinetRole.Satellite),
            },
            Now);

        Assert.True(group.SyncCabinetIsOffline);
        Assert.Contains("out of step", group.AccessibleSummary, StringComparison.Ordinal);
    }

    [Fact]
    public void A_standalone_site_is_described_as_standalone_rather_than_as_missing_something()
    {
        Guid siteId = Guid.NewGuid();

        var group = new SiteGroupRow(
            new[] { Summary("CAB-ONLY-01", siteId, CabinetRole.Standalone) },
            Now);

        Assert.Null(group.SyncCabinet);
        Assert.False(group.SyncCabinetIsOffline);
        Assert.Contains("standalone cabinet", group.Headline, StringComparison.Ordinal);
    }

    private static CabinetDetailDto Detail(
        CabinetRole role, SyncCabinetLinkDto? link, Guid? syncCabinetId = null) => new()
    {
        Cabinet = Summary("CUBEX-NG-07", Guid.NewGuid(), role),
        Site = new SiteSummary
        {
            Id = Guid.NewGuid(),
            ClientName = "Northgate Veterinary",
            SiteName = "Main Surgery",
            SyncCabinetId = link?.SyncCabinetId ?? syncCabinetId,
            CabinetCount = 3,
            UnhealthyCabinetCount = 0,
            WorstHealth = CabinetHealthStatus.Healthy,
        },
        SyncCabinetLink = link,
    };

    private static CabinetSummary Summary(
        string hostname,
        Guid siteId,
        CabinetRole role,
        CabinetHealthStatus health = CabinetHealthStatus.Healthy) => new()
    {
        Id = Guid.NewGuid(),
        MachineId = $"machine-{hostname}",
        Hostname = hostname,
        ClientName = "Northgate Veterinary",
        SiteName = "Main Surgery",
        SiteId = siteId,
        Role = role,
        IsActive = true,
        Health = health,
        WorstDiskHealth = DiskHealthStatus.Healthy,
        AnyUserLoggedOn = false,
    };
}
