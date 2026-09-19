using System.Net;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class HealthProjectionTests
{
    [Theory]
    [InlineData("noHeartbeat", CabinetHealthStatus.Unknown)]
    [InlineData("all", CabinetHealthStatus.Unknown)]
    [InlineData("cpu", CabinetHealthStatus.Unknown)]
    [InlineData("ram", CabinetHealthStatus.Unknown)]
    [InlineData("diskSpace", CabinetHealthStatus.Unknown)]
    [InlineData("updates", CabinetHealthStatus.Unknown)]
    [InlineData("clock", CabinetHealthStatus.Unknown)]
    [InlineData("complete", CabinetHealthStatus.Healthy)]
    [InlineData("critical", CabinetHealthStatus.Critical)]
    [InlineData("warning", CabinetHealthStatus.Warning)]
    [InlineData("failingDisk", CabinetHealthStatus.Critical)]
    [InlineData("watchDisk", CabinetHealthStatus.Warning)]
    [InlineData("offline", CabinetHealthStatus.Offline)]
    [InlineData("inactive", CabinetHealthStatus.Unknown)]
    public async Task Sql_filter_matches_detail_list_and_fleet_for_incomplete_coverage(
        string scenario, CabinetHealthStatus expected)
    {
        using var factory = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "health-projection");
        var target = await TestClient.CreateApprovedCabinetAsync(factory, "health-target", user.Id);
        await factory.WithDbAsync(async db =>
        {
            var cabinet = await db.Cabinets.SingleAsync(c => c.Id == target.Id);
            cabinet.LastCheckInUtc = scenario == "offline" ? DateTimeOffset.UtcNow.AddDays(-1) : DateTimeOffset.UtcNow;
            cabinet.IsActive = scenario != "inactive";
            if (scenario != "noHeartbeat")
            {
                bool incomplete = scenario is "all" or "critical" or "warning" or "failingDisk" or "watchDisk";
                db.Heartbeats.Add(new Heartbeat
                {
                    CabinetId = target.Id, CollectedAtUtc = DateTimeOffset.UtcNow, ReceivedUtc = DateTimeOffset.UtcNow,
                    CpuPercent = incomplete || scenario == "cpu" ? null : 10,
                    RamUsedPercent = scenario == "critical" ? 99 : scenario == "warning" ? 90 :
                        incomplete || scenario == "ram" ? null : 20,
                    MinFreeDiskPercent = incomplete || scenario == "diskSpace" ? null : 50,
                    PendingUpdateCount = incomplete || scenario == "updates" ? null : 0,
                    ClockDriftSeconds = incomplete || scenario == "clock" ? null : 0,
                    WorstDiskHealth = scenario == "failingDisk" ? DiskHealthStatus.Failing :
                        scenario == "watchDisk" ? DiskHealthStatus.Watch : DiskHealthStatus.Unknown
                });
            }
            await db.SaveChangesAsync();
        });

        // Exercise SQL classification before count/pagination, including its no-row fallback.
        foreach (var health in Enum.GetValues<CabinetHealthStatus>())
        {
            var response = await client.GetAsync($"/api/cabinets?IncludeInactive=true&Health={health}&Page=1&PageSize=1");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var page = (await response.ReadAsync<PagedResult<CabinetSummary>>())!;
            Assert.Equal(health == expected ? 1 : 0, page.TotalCount);
            if (health == expected)
            {
                var item = Assert.Single(page.Items);
                Assert.Equal(target.Id, item.Id);
                Assert.Equal(expected, item.Health);
            }
            else Assert.Empty(page.Items);
        }

        var detailResponse = await client.GetAsync($"/api/cabinets/{target.Id}");
        Assert.Equal(HttpStatusCode.OK, detailResponse.StatusCode);
        var detail = (await detailResponse.ReadAsync<CabinetDetailDto>())!;
        Assert.Equal(expected, detail.Cabinet.Health);
        Assert.Equal(scenario is "failingDisk" ? DiskHealthStatus.Failing : scenario is "watchDisk" ? DiskHealthStatus.Watch : DiskHealthStatus.Unknown,
            detail.Cabinet.WorstDiskHealth);

        var fleetResponse = await client.GetAsync("/api/fleet/health?IncludeInactive=true");
        Assert.Equal(HttpStatusCode.OK, fleetResponse.StatusCode);
        var fleet = (await fleetResponse.ReadAsync<FleetHealthSummary>())!;
        Assert.Equal(1, fleet.TotalCabinets);
        Assert.Equal(expected == CabinetHealthStatus.Unknown ? 1 : 0, fleet.Unknown);
        Assert.Equal(expected == CabinetHealthStatus.Healthy ? 1 : 0, fleet.Healthy);
        Assert.Equal(expected == CabinetHealthStatus.Warning ? 1 : 0, fleet.Warning);
        Assert.Equal(expected == CabinetHealthStatus.Critical ? 1 : 0, fleet.Critical);
        Assert.Equal(expected == CabinetHealthStatus.Offline ? 1 : 0, fleet.Offline);
    }

    [Fact]
    public async Task Accepted_full_checkin_with_missing_measurements_stays_unknown()
    {
        using var factory = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "missing-health");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "missing-metrics", user.Id);
        using var agent = TestClient.CreateAgentClient(factory, cabinet.MachineId);
        var collected = DateTimeOffset.UtcNow.AddMinutes(-1);
        var response = await agent.PostJsonAsync("/api/agent/checkin/full", new CheckInPayload
        {
            CabinetId = cabinet.Id, MachineId = cabinet.MachineId, AgentVersion = "test", CollectedAtUtc = collected
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var detail = (await (await client.GetAsync($"/api/cabinets/{cabinet.Id}")).ReadAsync<CabinetDetailDto>())!;
        Assert.Equal(CabinetHealthStatus.Unknown, detail.Cabinet.Health);
        Assert.NotNull(detail.Cabinet.LastCheckInUtc);
        Assert.Equal(collected, detail.LatestHeartbeat!.CollectedAtUtc);
        Assert.Null(detail.Cabinet.CpuPercent);
        Assert.Null(detail.Cabinet.RamUsedPercent);
        Assert.Null(detail.Cabinet.MinFreeDiskPercent);
        Assert.Null(detail.Cabinet.PendingUpdateCount);
        Assert.Equal(DiskHealthStatus.Unknown, detail.Cabinet.WorstDiskHealth);
    }
}
