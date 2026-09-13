using System.Net;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.BackgroundServices;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

public sealed class DiskHealthSafetyTests
{
    [Theory]
    [InlineData(DiskHealthStatus.Unknown, new DiskHealthStatus[0])]
    [InlineData(DiskHealthStatus.Healthy, new[] { DiskHealthStatus.Healthy })]
    [InlineData(DiskHealthStatus.Healthy, new[] { DiskHealthStatus.Healthy, DiskHealthStatus.Healthy })]
    [InlineData(DiskHealthStatus.Unknown, new[] { DiskHealthStatus.Healthy, DiskHealthStatus.Unknown })]
    [InlineData(DiskHealthStatus.Watch, new[] { DiskHealthStatus.Healthy, DiskHealthStatus.Watch })]
    [InlineData(DiskHealthStatus.Failing, new[] { DiskHealthStatus.Unknown, DiskHealthStatus.Failing })]
    public async Task Observed_disk_health_survives_ingest_and_retention(DiskHealthStatus expected, DiskHealthStatus[] health)
    {
        using var factory = new SupportApiFactory();
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "disk-health", Guid.NewGuid());
        using var agent = TestClient.CreateAgentClient(factory, cabinet.MachineId);
        var payload = new CheckInPayload
        {
            AgentVersion = "test", MachineId = cabinet.MachineId, CabinetId = cabinet.Id,
            CollectedAtUtc = DateTimeOffset.UtcNow,
            Disks = health.Select(h => new DiskInfo { HealthStatus = h, BitLockerStatus = BitLockerStatus.Unknown }).ToArray()
        };
        var response = await agent.PostJsonAsync("/api/agent/checkin/full", payload);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await factory.WithDbAsync(async db =>
        {
            var heartbeat = await db.Heartbeats.SingleAsync();
            Assert.Equal(expected, heartbeat.WorstDiskHealth);
            heartbeat.ReceivedUtc = DateTimeOffset.UtcNow.AddDays(-45);
            db.SmartReadings.Add(new SmartReading
            {
                CabinetId = cabinet.Id, DriveSerial = "test-drive", TimestampUtc = DateTimeOffset.UtcNow.AddDays(-200),
                Health = expected
            });
            await db.SaveChangesAsync();
        });
        using var retention = new RetentionService(factory.Services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new RetentionOptions { BatchSize = 10 }), TimeProvider.System, NullLogger<RetentionService>.Instance);
        await retention.SweepAsync(default);
        await factory.WithDbAsync(async db =>
        {
            Assert.Equal(expected, (await db.Heartbeats.SingleAsync(h => h.IsAggregated)).WorstDiskHealth);
            Assert.Equal(expected, (await db.SmartReadings.SingleAsync(h => h.IsAggregated)).Health);
        });
    }
}
