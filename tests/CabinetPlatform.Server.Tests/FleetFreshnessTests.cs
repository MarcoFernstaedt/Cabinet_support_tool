using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using System.Text.Json;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class FleetFreshnessTests
{
    [Fact]
    public async Task Site_pages_follow_global_client_site_id_order_even_when_later_site_is_worse()
    {
        using var factory = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "site-order");
        string name = $"Sites {Guid.NewGuid():N}";
        Cabinet alpha = await TestClient.CreateApprovedCabinetAsync(factory, $"alpha-{Guid.NewGuid():N}", user.Id, clientName: name, siteName: "Alpha");
        Cabinet beta = await TestClient.CreateApprovedCabinetAsync(factory, $"beta-{Guid.NewGuid():N}", user.Id, clientName: name, siteName: "Beta");
        Cabinet gamma = await TestClient.CreateApprovedCabinetAsync(factory, $"gamma-{Guid.NewGuid():N}", user.Id, clientName: name, siteName: "Gamma");
        await factory.WithDbAsync(async db =>
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            (await db.Cabinets.SingleAsync(c => c.Id == alpha.Id)).LastCheckInUtc = now;
            (await db.Cabinets.SingleAsync(c => c.Id == gamma.Id)).LastCheckInUtc = now.AddDays(-2);
            db.Heartbeats.Add(new Heartbeat { CabinetId = alpha.Id, CollectedAtUtc = now, ReceivedUtc = now,
                CpuPercent = 10, RamUsedPercent = 20, MinFreeDiskPercent = 50, PendingUpdateCount = 0, ClockDriftSeconds = 0 });
            await db.SaveChangesAsync();
        });
        string url = $"/api/fleet/sites?clientName={Uri.EscapeDataString(name)}&pageSize=2&page=";
        var pages = new List<SiteSummary>();
        foreach (int n in new[] { 1, 2, 3 })
        {
            var page = (await (await client.GetAsync(url + n)).ReadAsync<PagedResult<SiteSummary>>())!;
            Assert.Equal(3, page.TotalCount);
            pages.AddRange(page.Items);
        }
        Assert.Equal(new[] { alpha.SiteId, beta.SiteId, gamma.SiteId }, pages.Select(s => s.Id));
        Assert.Equal(3, pages.Select(s => s.Id).Distinct().Count());
        Assert.Equal(CabinetHealthStatus.Healthy, pages[0].WorstHealth);
        Assert.Equal(CabinetHealthStatus.Unknown, pages[1].WorstHealth);
        Assert.Equal(CabinetHealthStatus.Offline, pages[2].WorstHealth);
        var repeat = (await (await client.GetAsync(url + "2")).ReadAsync<PagedResult<SiteSummary>>())!;
        Assert.Equal(gamma.SiteId, Assert.Single(repeat.Items).Id);
    }

    [Fact]
    public async Task Contact_and_measurement_freshness_remain_distinct_across_list_detail_and_aggregate()
    {
        using var factory = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "fleet-freshness");
        string clientName = $"Freshness {Guid.NewGuid():N}";
        Cabinet replay = await TestClient.CreateApprovedCabinetAsync(factory, $"replay-{Guid.NewGuid():N}", user.Id, clientName: clientName);
        Cabinet never = await TestClient.CreateApprovedCabinetAsync(factory, $"never-{Guid.NewGuid():N}", user.Id, clientName: clientName);
        Cabinet fresh = await TestClient.CreateApprovedCabinetAsync(factory, $"fresh-{Guid.NewGuid():N}", user.Id, clientName: clientName);
        Cabinet inactive = await TestClient.CreateApprovedCabinetAsync(factory, $"inactive-{Guid.NewGuid():N}", user.Id, isActive: false, clientName: clientName);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        DateTimeOffset old = now.AddHours(-3);
        DateTimeOffset received = now.AddMinutes(-1);
        await factory.WithDbAsync(async db =>
        {
            foreach (Guid id in new[] { replay.Id, never.Id, fresh.Id, inactive.Id })
                (await db.Cabinets.SingleAsync(c => c.Id == id)).LastCheckInUtc = received;
            db.Heartbeats.AddRange(
                new Heartbeat { CabinetId = replay.Id, CollectedAtUtc = old, ReceivedUtc = received, CpuPercent = 10, RamUsedPercent = 20, MinFreeDiskPercent = 50, PendingUpdateCount = 0, ClockDriftSeconds = 0 },
                new Heartbeat { CabinetId = fresh.Id, CollectedAtUtc = received, ReceivedUtc = received, CpuPercent = 10, RamUsedPercent = 20, MinFreeDiskPercent = 50, PendingUpdateCount = 0, ClockDriftSeconds = 0 },
                new Heartbeat { CabinetId = inactive.Id, CollectedAtUtc = old, ReceivedUtc = received });
            await db.SaveChangesAsync();
        });
        string filter = $"clientName={Uri.EscapeDataString(clientName)}";
        using var listResponse = await client.GetAsync($"/api/cabinets?{filter}&includeInactive=true&pageSize=10");
        using (var json = JsonDocument.Parse(await listResponse.Content.ReadAsStringAsync()))
        {
            var first = json.RootElement.GetProperty("items")[0];
            Assert.True(first.TryGetProperty("latestHeartbeatCollectedAtUtc", out _));
            Assert.True(first.TryGetProperty("latestHeartbeatReceivedAtUtc", out _));
        }
        var page = (await listResponse.ReadAsync<PagedResult<CabinetSummary>>())!;
        var byId = page.Items.ToDictionary(c => c.Id);
        Assert.Equal(old, byId[replay.Id].LatestHeartbeatCollectedAtUtc);
        Assert.Equal(received, byId[replay.Id].LatestHeartbeatReceivedAtUtc);
        Assert.Equal(received, byId[replay.Id].LastCheckInUtc);
        Assert.Null(byId[never.Id].LatestHeartbeatCollectedAtUtc);
        Assert.Null(byId[never.Id].LatestHeartbeatReceivedAtUtc);
        var detail = (await (await client.GetAsync($"/api/cabinets/{replay.Id}")).ReadAsync<CabinetDetailDto>())!;
        Assert.Equal(old, detail.Cabinet.LatestHeartbeatCollectedAtUtc);
        Assert.Equal(received, detail.Cabinet.LatestHeartbeatReceivedAtUtc);
        using var fleetResponse = await client.GetAsync($"/api/fleet/health?{filter}&staleAfterHours=1");
        using (var json = JsonDocument.Parse(await fleetResponse.Content.ReadAsStringAsync()))
        {
            Assert.Equal(1, json.RootElement.GetProperty("noMeasurement").GetInt32());
            Assert.Equal(1, json.RootElement.GetProperty("staleMeasurement").GetInt32());
            Assert.Equal(1, json.RootElement.GetProperty("measurementStaleAfterHours").GetInt32());
        }
        var fleet = (await fleetResponse.ReadAsync<FleetHealthSummary>())!;
        Assert.Equal(3, fleet.TotalCabinets);
        Assert.Equal(1, fleet.Inactive);
        Assert.Equal(0, fleet.Stale);
        Assert.Equal(1, fleet.NoMeasurement);
        Assert.Equal(1, fleet.StaleMeasurement);
        Assert.Equal(1, fleet.MeasurementStaleAfterHours);
        Assert.Equal(1, fleet.Unknown);
        Assert.Equal(2, fleet.Healthy);
        Assert.InRange(fleet.GeneratedUtc, now, DateTimeOffset.UtcNow);
    }

    [Fact]
    public async Task Collection_order_outweighs_later_receipt_for_list_and_aggregate()
    {
        using var factory = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "fleet-tie");
        string clientName = $"Tie {Guid.NewGuid():N}";
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(factory, $"tie-{Guid.NewGuid():N}", user.Id, clientName: clientName);
        DateTimeOffset collected = DateTimeOffset.UtcNow.AddMinutes(-2);
        Guid low = Guid.Parse("00000000-0000-0000-0000-000000000001");
        Guid high = Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff");
        await factory.WithDbAsync(async db =>
        {
            (await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id)).LastCheckInUtc = DateTimeOffset.UtcNow;
            db.Heartbeats.AddRange(
                new Heartbeat { Id = low, CabinetId = cabinet.Id, CollectedAtUtc = collected, ReceivedUtc = collected.AddMinutes(2), CpuPercent = 10, RamUsedPercent = 20, MinFreeDiskPercent = 50, PendingUpdateCount = 0, ClockDriftSeconds = 0 },
                new Heartbeat { Id = high, CabinetId = cabinet.Id, CollectedAtUtc = collected.AddMinutes(1), ReceivedUtc = collected.AddMinutes(1), CpuPercent = 10, RamUsedPercent = 99, MinFreeDiskPercent = 50, PendingUpdateCount = 0, ClockDriftSeconds = 0 });
            await db.SaveChangesAsync();
        });
        string filter = $"clientName={Uri.EscapeDataString(clientName)}";
        var page = (await (await client.GetAsync($"/api/cabinets?{filter}")).ReadAsync<PagedResult<CabinetSummary>>())!;
        var row = Assert.Single(page.Items);
        Assert.Equal(CabinetHealthStatus.Critical, row.Health);
        Assert.Equal(collected.AddMinutes(1), row.LatestHeartbeatReceivedAtUtc);
        var fleet = (await (await client.GetAsync($"/api/fleet/health?{filter}")).ReadAsync<FleetHealthSummary>())!;
        Assert.Equal(1, fleet.Critical);
        Assert.Equal(0, fleet.Healthy);
        Assert.Equal(0, fleet.NoMeasurement);
        Assert.Equal(0, fleet.StaleMeasurement);
    }
}
