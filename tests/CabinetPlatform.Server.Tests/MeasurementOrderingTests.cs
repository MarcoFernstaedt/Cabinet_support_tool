using System.Net;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class MeasurementOrderingTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public MeasurementOrderingTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Buffered_healthy_full_sample_does_not_replace_current_critical_facts()
    {
        var (user, agent, cabinet) = await CreateAsync();
        var fresh = Sample(cabinet, DateTimeOffset.UtcNow.AddMinutes(-1), true);
        Assert.Equal(HttpStatusCode.OK, (await agent.PostJsonAsync("/api/agent/checkin/full", fresh)).StatusCode);
        var before = await StoredAsync(cabinet.Id);
        var old = Sample(cabinet, fresh.CollectedAtUtc.AddHours(-2), false);
        Assert.Equal(HttpStatusCode.OK, (await agent.PostJsonAsync("/api/agent/checkin/full", old)).StatusCode);
        var after = await StoredAsync(cabinet.Id);
        Assert.Equal("critical-host", after.Hostname);
        Assert.Equal(before.CurrentInventoryVersionId, after.CurrentInventoryVersionId);
        Assert.Equal(1, after.AutoStartServicesStoppedCount);
        Assert.True(after.LastCheckInUtc >= before.LastCheckInUtc);
        Assert.Equal(before.LastFullCheckInUtc, after.LastFullCheckInUtc);
        Assert.Equal(2, await _factory.WithDbAsync(db => db.Heartbeats.CountAsync(h => h.CabinetId == cabinet.Id)));
        Assert.Equal(2, await _factory.WithDbAsync(db => db.SmartReadings.CountAsync(h => h.CabinetId == cabinet.Id)));
        var response = await user.GetAsync($"/api/cabinets/{cabinet.Id}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var detail = await response.ReadAsync<CabinetDetailDto>();
        Assert.NotNull(detail);
        Assert.Equal(fresh.CollectedAtUtc, detail.LatestHeartbeat!.CollectedAtUtc);
        Assert.Equal(CabinetHealthStatus.Critical, detail.Cabinet.Health);
        Assert.Equal(DiskHealthStatus.Failing, detail.Cabinet.WorstDiskHealth);
        Assert.Equal(fresh.CollectedAtUtc, detail.CurrentInventory!.LastObservedUtc);
        var page = await (await user.GetAsync($"/api/cabinets?SiteId={cabinet.SiteId}&Health=Critical"))
            .ReadAsync<PagedResult<CabinetSummary>>();
        Assert.Contains(page!.Items, c => c.Id == cabinet.Id && c.Health == CabinetHealthStatus.Critical);
        var fleet = await (await user.GetAsync($"/api/fleet/health?siteId={cabinet.SiteId}"))
            .ReadAsync<FleetHealthSummary>();
        Assert.Equal(1, fleet!.Critical);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Equal_timestamp_full_replay_is_idempotent_even_with_conflicting_content(bool conflicting)
    {
        var (_, agent, cabinet) = await CreateAsync();
        var sample = Sample(cabinet, DateTimeOffset.UtcNow.AddMinutes(-1), true);
        Assert.Equal(HttpStatusCode.OK, (await agent.PostJsonAsync("/api/agent/checkin/full", sample)).StatusCode);
        var before = await StoredAsync(cabinet.Id);
        var replay = conflicting ? Sample(cabinet, sample.CollectedAtUtc, false)
            : sample with { CollectedAtUtc = sample.CollectedAtUtc.ToOffset(TimeSpan.FromHours(2)) };
        // A new HTTP client/request scope has no in-memory deduplication state.
        using var restarted = TestClient.CreateAgentClient(_factory, cabinet.MachineId);
        var response = await restarted.PostJsonAsync("/api/agent/checkin/full", replay);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True((await response.ReadAsync<CheckInResponse>())!.WasDuplicate);
        Assert.Equal(1, await _factory.WithDbAsync(db => db.SmartReadings.CountAsync(h => h.CabinetId == cabinet.Id)));
        Assert.Equal(1, await _factory.WithDbAsync(db => db.InventoryVersions.CountAsync(h => h.CabinetId == cabinet.Id)));
        Assert.Equal(1, await _factory.WithDbAsync(db => db.Heartbeats.CountAsync(h => h.CabinetId == cabinet.Id)));
        Assert.Equal(1, await _factory.WithDbAsync(db => db.AuditEntries.CountAsync(a =>
            a.CabinetId == cabinet.Id && a.Event == AuditEvent.AgentCheckIn)));
        var after = await StoredAsync(cabinet.Id);
        Assert.Equal(before.CurrentInventoryVersionId, after.CurrentInventoryVersionId);
        Assert.Equal("critical-host", after.Hostname);
        Assert.Equal(before.LastFullCheckInUtc, after.LastFullCheckInUtc);
        Assert.True(after.LastCheckInUtc >= before.LastCheckInUtc);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(60)]
    [InlineData(0)]
    public async Task Future_or_missing_collection_time_cannot_replace_a_valid_measurement(int minutesAhead)
    {
        var (user, agent, cabinet) = await CreateAsync();
        var fresh = Sample(cabinet, DateTimeOffset.UtcNow.AddMinutes(-1), true);
        Assert.Equal(HttpStatusCode.OK, (await agent.PostJsonAsync("/api/agent/checkin/full", fresh)).StatusCode);
        var badTime = minutesAhead == 0 ? default : DateTimeOffset.UtcNow.AddMinutes(minutesAhead);
        var response = await agent.PostJsonAsync("/api/agent/checkin/full", Sample(cabinet, badTime, false));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(1, await _factory.WithDbAsync(db => db.Heartbeats.CountAsync(h => h.CabinetId == cabinet.Id)));
        Assert.Equal(1, await _factory.WithDbAsync(db => db.SmartReadings.CountAsync(h => h.CabinetId == cabinet.Id)));
        Assert.Equal("critical-host", (await StoredAsync(cabinet.Id)).Hostname);
        var detail = await (await user.GetAsync($"/api/cabinets/{cabinet.Id}")).ReadAsync<CabinetDetailDto>();
        Assert.Equal(fresh.CollectedAtUtc, detail!.LatestHeartbeat!.CollectedAtUtc);
    }

    [Fact]
    public async Task Concurrent_out_of_order_full_samples_leave_the_newest_facts_current()
    {
        var (_, agent, cabinet) = await CreateAsync();
        var newestTime = DateTimeOffset.UtcNow.AddMinutes(-1);
        var submissions = Enumerable.Range(0, 12).Select(i =>
            agent.PostJsonAsync("/api/agent/checkin/full",
                Sample(cabinet, newestTime.AddSeconds(-i), i == 0))).ToArray();
        var responses = await Task.WhenAll(submissions);
        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        var stored = await StoredAsync(cabinet.Id);
        Assert.Equal("critical-host", stored.Hostname);
        Assert.Equal(1, stored.AutoStartServicesStoppedCount);
        Assert.Equal(newestTime, stored.LastFullCheckInUtc);
        var inventory = await _factory.WithDbAsync(db => db.InventoryVersions.AsNoTracking()
            .SingleAsync(v => v.Id == stored.CurrentInventoryVersionId));
        Assert.Equal(newestTime, inventory.LastObservedUtc);
        Assert.Equal(12, await _factory.WithDbAsync(db => db.Heartbeats.CountAsync(h => h.CabinetId == cabinet.Id)));
    }

    private async Task<(HttpClient User, HttpClient Agent, Cabinet Cabinet)> CreateAsync()
    {
        var (user, supervisor) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, $"order-{Guid.NewGuid():N}");
        string machine = $"order-{Guid.NewGuid():N}";
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, machine, supervisor.Id, siteName: machine);
        return (user, TestClient.CreateAgentClient(_factory, machine), cabinet);
    }

    private Task<Cabinet> StoredAsync(Guid id) => _factory.WithDbAsync(db => db.Cabinets.AsNoTracking().SingleAsync(c => c.Id == id));

    private static CheckInPayload Sample(Cabinet cabinet, DateTimeOffset time, bool critical) => new()
    {
        CabinetId = cabinet.Id, MachineId = cabinet.MachineId, AgentVersion = "test-1",
        CollectedAtUtc = time,
        System = new SystemInfo { Hostname = critical ? "critical-host" : "healthy-host" },
        Performance = new PerformanceInfo { CpuTotalPercent = 20, RamUsedPercent = 40 },
        Services = new[] { new ServiceInfo { Name = "observed-service", StartType = ServiceStartType.Automatic,
            State = critical ? ServiceState.Stopped : ServiceState.Running } },
        Disks = new[] { new DiskInfo { DriveLetter = "C", FreePercent = critical ? 1 : 80,
            BitLockerStatus = BitLockerStatus.Unknown,
            HealthStatus = critical ? DiskHealthStatus.Failing : DiskHealthStatus.Healthy,
            Smart = new SmartInfo { Source = SmartSource.StorageReliabilityCounter,
                SerialNumber = "synthetic-drive", PowerOnHours = 100 } } }
    };
}
