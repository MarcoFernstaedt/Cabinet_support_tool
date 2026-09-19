using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class MonitoringFreshnessTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-09-19T18:00:00Z");

    internal static CabinetSummary Cabinet(DateTimeOffset? seen) => new()
    {
        Id = Guid.NewGuid(), MachineId = "test-monitor", Hostname = "TEST-01",
        ClientName = "Test client", SiteName = "Test site", SiteId = Guid.NewGuid(),
        Role = CabinetRole.Standalone, IsActive = true, LastCheckInUtc = seen,
        Health = CabinetHealthStatus.Healthy, WorstDiskHealth = DiskHealthStatus.Healthy
    };

    [Theory]
    [InlineData("2026-01-19T18:00:00Z")]
    [InlineData("2026-07-19T18:00:00Z")]
    public void Support_timestamps_use_fixed_MST_in_winter_and_summer(string timestamp)
    {
        var instant = DateTimeOffset.Parse(timestamp);
        var rendered = Format.LocalTime(instant);
        Assert.Contains(instant.ToOffset(TimeSpan.FromHours(-7)).ToString("yyyy-MM-dd HH:mm:ss"), rendered);
        Assert.Contains("-07:00", rendered);
        Assert.Contains("MST", rendered);
        Assert.DoesNotContain("MDT", rendered);
    }

    [Theory]
    [InlineData(-31, "Stale")]
    [InlineData(-30, "Stale")]
    [InlineData(1, "Unknown")]
    public void Check_in_age_has_conservative_boundaries(int minutes, string label)
    {
        Assert.Contains(label, MonitoringFreshness.ForLastSeen(Now.AddMinutes(minutes), Now).Label);
    }

    [Fact]
    public void Missing_check_in_is_unknown_and_offline_is_explicit()
    {
        Assert.Contains("Unknown", new CabinetRow(Cabinet(null), Now).Health.Label);
        Assert.Contains("Disconnected", new CabinetRow(Cabinet(Now) with
            { Health = CabinetHealthStatus.Offline }, Now).Health.Label);
        Assert.NotEqual(StatusSeverity.Good, new CabinetRow(Cabinet(Now), Now).Health.Severity);
    }

    [Fact]
    public void Site_rollup_does_not_call_stale_cabinets_all_healthy()
    {
        var site = new CabinetPlatform.Console.Core.ViewModels.SiteGroupRow(new[] { Cabinet(Now.AddHours(-1)) }, Now);
        Assert.DoesNotContain("All healthy", site.AccessibleSummary);
        Assert.Equal(1, site.NeedsAttentionCount);
    }

    [Fact]
    public void Finder_cannot_show_cached_healthy_when_last_seen_is_old()
    {
        var cabinet = Cabinet(Now.AddHours(-1));
        var row = new CabinetSearchRow(new CabinetSearchHit
        {
            Cabinet = cabinet, Path = CabinetPath.From(cabinet), MatchedOn = CabinetSearchMatch.Hostname
        }, Now);
        Assert.Contains("Stale", row.Health.Label);
        Assert.Contains("Last seen", row.AccessibleSummary);
    }

    [Fact]
    public void Recent_open_time_is_not_a_check_in_and_cannot_be_green()
    {
        var row = new RecentCabinetRow(new RecentCabinetDto
        {
            Path = CabinetPath.From(Cabinet(Now)), LastViewedUtc = Now, Health = CabinetHealthStatus.Healthy
        }, Now);
        Assert.NotEqual(StatusSeverity.Good, row.Health.Severity);
        Assert.Contains("Last seen: Unknown", row.AccessibleSummary);
    }

    [Fact]
    public void Aggregate_healthy_count_is_historical_not_live_green()
    {
        var row = new CabinetPlatform.Console.Core.ViewModels.FleetCountRow(
            StatusPresentation.ForCabinet(CabinetHealthStatus.Healthy), 3);
        Assert.NotEqual(StatusSeverity.Good, row.Severity);
        Assert.Contains("Last reported", row.AccessibleSummary);
    }

    [Fact]
    public void Recent_site_check_ins_are_not_proof_all_metrics_are_healthy()
    {
        var site = new CabinetPlatform.Console.Core.ViewModels.SiteGroupRow(new[] { Cabinet(Now) }, Now);
        Assert.DoesNotContain("All healthy", site.AccessibleSummary);
        Assert.Contains("unverified", site.AccessibleSummary);
    }

    [Fact]
    public void Stale_snapshot_preserves_reported_critical_problem()
    {
        var row = new CabinetRow(Cabinet(Now.AddHours(-1)) with { Health = CabinetHealthStatus.Critical }, Now);
        Assert.Contains("Stale", row.Health.Label);
        Assert.Contains("Critical", row.Health.Label);
        Assert.Equal(StatusSeverity.Critical, row.Health.Severity);
    }

    [Fact]
    public void Stale_list_snapshot_is_not_healthy_even_if_server_cached_healthy()
    {
        var row = new CabinetRow(Cabinet(Now.AddHours(-1)), Now);
        Assert.Contains("Stale", row.Health.Label);
        Assert.NotEqual(StatusSeverity.Good, row.DiskHealth.Severity);
        Assert.Contains("Last seen", row.AccessibleSummary);
    }
}
