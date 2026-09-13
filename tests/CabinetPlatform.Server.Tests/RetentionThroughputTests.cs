using CabinetPlatform.Server.BackgroundServices;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

public sealed class RetentionThroughputTests
{
    [Fact]
    public async Task A_sweep_drains_multiple_bounded_batches_without_losing_samples()
    {
        using var factory = new SupportApiFactory();
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "retention-backlog", Guid.NewGuid());
        var hour = new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await factory.WithDbAsync(async db =>
        {
            for (int i = 1; i <= 7; i++)
            {
                db.Heartbeats.Add(new Heartbeat
                {
                    CabinetId = cabinet.Id, ReceivedUtc = hour.AddMinutes(i), CollectedAtUtc = hour.AddMinutes(i), SampleCount = 1
                });
            }
            await db.SaveChangesAsync();
        });
        using var retention = new RetentionService(factory.Services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new RetentionOptions { BatchSize = 2, HeartbeatAggregateRetentionDays = 5000 }),
            TimeProvider.System, NullLogger<RetentionService>.Instance);
        await retention.SweepAsync(default);
        await factory.WithDbAsync(async db =>
        {
            var aggregate = Assert.Single(await db.Heartbeats.ToListAsync());
            Assert.True(aggregate.IsAggregated);
            Assert.Equal(7, aggregate.SampleCount);
        });
    }
}
