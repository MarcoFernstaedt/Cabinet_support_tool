using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class DemoPerformanceReadTests
{
    [Fact]
    public async Task Exact_grant_reads_latest_raw_sample_with_collection_and_receipt_provenance()
    {
        using var factory = new SupportApiFactory();
        var (reader, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "performance-reader");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "performance-machine", user.Id);
        var now = DateTimeOffset.UtcNow;
        await factory.WithDbAsync(async db =>
        {
            db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id });
            db.Heartbeats.AddRange(
                new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = now.AddMinutes(-4), ReceivedUtc = now.AddMinutes(-3), CpuPercent = 17, RamUsedPercent = 51, MinFreeDiskPercent = 24 },
                new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = now.AddMinutes(-2), ReceivedUtc = now.AddMinutes(-1), CpuPercent = 31, RamUsedPercent = null, MinFreeDiskPercent = 9 });
            await db.SaveChangesAsync();
        });
        using var response = await reader.GetAsync($"/api/demo/cabinets/{cabinet.Id}/performance");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        Assert.Equal(cabinet.Id, root.GetProperty("cabinetId").GetGuid());
        Assert.Equal("current", root.GetProperty("state").GetString());
        Assert.Equal(now.AddMinutes(-2).ToUnixTimeSeconds(), root.GetProperty("collectedAtUtc").GetDateTimeOffset().ToUnixTimeSeconds());
        Assert.Equal(now.AddMinutes(-1).ToUnixTimeSeconds(), root.GetProperty("receivedUtc").GetDateTimeOffset().ToUnixTimeSeconds());
        Assert.Equal(31, root.GetProperty("cpuPercent").GetDouble());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("ramUsedPercent").ValueKind);
        Assert.Equal(9, root.GetProperty("minFreeDiskPercent").GetDouble());
        Assert.Equal(new[] { "cabinetId", "collectedAtUtc", "cpuPercent", "minFreeDiskPercent", "ramUsedPercent", "receivedUtc", "state" },
            root.EnumerateObject().Select(p => p.Name).OrderBy(x => x).ToArray());
    }

    [Fact]
    public async Task Missing_stale_and_unknown_remain_distinct_and_aggregates_are_not_live_readings()
    {
        using var factory = new SupportApiFactory();
        var (reader, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "performance-states");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "performance-states-machine", user.Id);
        await factory.WithDbAsync(async db => { db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id }); await db.SaveChangesAsync(); });
        string path = $"/api/demo/cabinets/{cabinet.Id}/performance";
        async Task<JsonDocument> Read()
        {
            using var response = await reader.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        }
        using (var missing = await Read()) Assert.Equal("missing", missing.RootElement.GetProperty("state").GetString());
        var old = DateTimeOffset.UtcNow.AddDays(-2);
        await factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = old, ReceivedUtc = old, CpuPercent = 42 });
            await db.SaveChangesAsync();
        });
        using (var stale = await Read()) Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
        await factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = DateTimeOffset.UtcNow.AddMinutes(-1), ReceivedUtc = DateTimeOffset.UtcNow, IsAggregated = true, CpuPercent = 99 });
            await db.SaveChangesAsync();
        });
        using (var stale = await Read()) Assert.Equal(42, stale.RootElement.GetProperty("cpuPercent").GetDouble());
        await factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = DateTimeOffset.UtcNow.AddSeconds(-5), ReceivedUtc = DateTimeOffset.UtcNow, CpuPercent = null });
            await db.SaveChangesAsync();
        });
        using (var unknown = await Read())
        {
            Assert.Equal("unknown", unknown.RootElement.GetProperty("state").GetString());
            Assert.Equal(JsonValueKind.Null, unknown.RootElement.GetProperty("cpuPercent").ValueKind);
        }
    }

    [Fact]
    public async Task Missing_grant_and_revocation_deny_without_leaking_sample()
    {
        using var factory = new SupportApiFactory();
        var (reader, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, "performance-owner");
        var (other, _) = await TestClient.CreateUserClientAsync(factory, Role.Supervisor, "performance-other");
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, "performance-private", user.Id);
        string path = $"/api/demo/cabinets/{cabinet.Id}/performance";
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync(path)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync(path)).StatusCode);
        await factory.WithDbAsync(async db => { db.CabinetReadGrants.Add(new CabinetReadGrant { UserId = user.Id, CabinetId = cabinet.Id }); await db.SaveChangesAsync(); });
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync(path)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync(path)).StatusCode);
        await factory.WithDbAsync(async db => await db.Cabinets.Where(c => c.Id == cabinet.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.IsActive, false)));
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync(path)).StatusCode);
        await factory.WithDbAsync(async db => await db.Cabinets.Where(c => c.Id == cabinet.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.IsActive, true)));
        await factory.WithDbAsync(async db => await db.CabinetReadGrants.Where(g => g.UserId == user.Id && g.CabinetId == cabinet.Id).ExecuteDeleteAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync(path)).StatusCode);
    }
}
