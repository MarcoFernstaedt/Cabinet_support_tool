using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class HealthPagingTests
{
    [Theory]
    [InlineData(CabinetHealthStatus.Critical)]
    [InlineData(CabinetHealthStatus.Warning)]
    [InlineData(CabinetHealthStatus.Offline)]
    [InlineData(CabinetHealthStatus.Healthy)]
    public async Task Health_filter_precedes_count_and_page(CabinetHealthStatus health)
    {
        using var factory = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "paging");
        await TestClient.CreateApprovedCabinetAsync(factory, "a-unknown", user.Id);
        var target = await TestClient.CreateApprovedCabinetAsync(factory, "z-target", user.Id);
        await factory.WithDbAsync(async db =>
        {
            var cabinet = await db.Cabinets.SingleAsync(c => c.Id == target.Id);
            cabinet.LastCheckInUtc = health == CabinetHealthStatus.Offline ? DateTimeOffset.UtcNow.AddDays(-1) : DateTimeOffset.UtcNow;
            db.Heartbeats.Add(new Heartbeat
            {
                CabinetId = target.Id, CollectedAtUtc = DateTimeOffset.UtcNow, ReceivedUtc = DateTimeOffset.UtcNow,
                // Healthy requires complete normal measurements, not just normal RAM.
                CpuPercent = 10, MinFreeDiskPercent = 50, PendingUpdateCount = 0, ClockDriftSeconds = 0,
                RamUsedPercent = health == CabinetHealthStatus.Critical ? 99 : health == CabinetHealthStatus.Warning ? 90 : 20
            });
            await db.SaveChangesAsync();
        });
        var response = await client.GetAsync($"/api/cabinets?Health={health}&Page=1&PageSize=1");
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var page = await response.ReadAsync<PagedResult<CabinetSummary>>();
        Assert.NotNull(page);
        Assert.Equal(1, page.TotalCount);
        Assert.Equal(target.Id, Assert.Single(page.Items).Id);
    }
}
