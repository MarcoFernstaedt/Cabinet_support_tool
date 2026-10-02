using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetStorageTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public CabinetStorageTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Empty_storage_is_unknown_and_bound_to_the_requested_cabinet()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var other = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        await _factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat { CabinetId = other.Id, CollectedAtUtc = DateTimeOffset.UtcNow, ReceivedUtc = DateTimeOffset.UtcNow, MinFreeDiskPercent = 98, WorstDiskHealth = DiskHealthStatus.Healthy });
            await db.SaveChangesAsync();
        });
        var response = await support.GetAsync($"/api/cabinets/{cabinet.Id}/storage");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.ReadAsync<JsonElement>();
        Assert.Equal(cabinet.Id, json.GetProperty("cabinetId").GetGuid());
        Assert.True(json.GetProperty("asOfUtc").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(-1));
        Assert.Equal(JsonValueKind.Null, json.GetProperty("heartbeat").ValueKind);
        Assert.Empty(json.GetProperty("volumes").EnumerateArray());
        Assert.Empty(json.GetProperty("smart").EnumerateArray());
    }

    [Fact]
    public async Task Historical_inventory_and_smart_preserve_measurement_and_missing_counters()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var old = DateTimeOffset.UtcNow.AddDays(-20);
        var newer = old.AddDays(19);
        await _factory.WithDbAsync(async db =>
        {
            db.Heartbeats.AddRange(
                new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = newer, ReceivedUtc = newer, MinFreeDiskPercent = 0, WorstDiskHealth = DiskHealthStatus.Healthy },
                new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = old, ReceivedUtc = DateTimeOffset.UtcNow, MinFreeDiskPercent = 99, WorstDiskHealth = DiskHealthStatus.Failing });
            var version = new InventoryVersion { CabinetId = cabinet.Id, FirstObservedUtc = old, LastObservedUtc = newer,
                ContentHash = "synthetic", PayloadJson = "{\"disks\":[{\"label\":\"private-patient\",\"driveLetter\":\"Z:\",\"freePercent\":12.5},{\"freePercent\":null}]}" };
            db.InventoryVersions.Add(version);
            var tracked = await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id);
            tracked.CurrentInventoryVersionId = version.Id;
            db.SmartReadings.AddRange(
                new SmartReading { CabinetId = cabinet.Id, DriveSerial = "private-serial-A", DriveModel = "private-model", TimestampUtc = old, Health = DiskHealthStatus.Failing, TemperatureCelsius = 90 },
                new SmartReading { CabinetId = cabinet.Id, DriveSerial = "private-serial-A", TimestampUtc = newer, Health = DiskHealthStatus.Healthy, TemperatureCelsius = null, ReallocatedSectorCount = 0 },
                new SmartReading { CabinetId = cabinet.Id, DriveSerial = "removed-drive", TimestampUtc = old, Health = DiskHealthStatus.Watch, PendingSectorCount = 2, IsAggregated = true });
            await db.SaveChangesAsync();
        });
        var response = await support.GetAsync($"/api/cabinets/{cabinet.Id}/storage");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        string raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("private-patient", raw);
        Assert.DoesNotContain("private-serial", raw);
        Assert.DoesNotContain("private-model", raw);
        Assert.DoesNotContain("removed-drive", raw);
        Assert.DoesNotContain("driveLetter", raw);
        Assert.DoesNotContain("contentHash", raw);
        var json = JsonDocument.Parse(raw).RootElement;
        var heartbeat = json.GetProperty("heartbeat");
        Assert.Equal(newer, heartbeat.GetProperty("collectedAtUtc").GetDateTimeOffset());
        Assert.Equal(0, heartbeat.GetProperty("diskFreePercent").GetDouble());
        Assert.Equal("Healthy", heartbeat.GetProperty("worstDiskHealth").GetString());
        var volumes = json.GetProperty("volumes").EnumerateArray().ToArray();
        Assert.Equal(2, volumes.Length);
        Assert.Equal(12.5, volumes[0].GetProperty("freePercent").GetDouble());
        Assert.Equal(old, volumes[0].GetProperty("embeddedValuesMeasuredAtUtc").GetDateTimeOffset());
        Assert.Equal(newer, volumes[0].GetProperty("observationLastUtc").GetDateTimeOffset());
        Assert.Equal(JsonValueKind.Null, volumes[1].GetProperty("freePercent").ValueKind);
        var smart = json.GetProperty("smart").EnumerateArray().ToArray();
        Assert.Equal(2, smart.Length);
        Assert.Equal(newer, smart[0].GetProperty("observedUtc").GetDateTimeOffset());
        Assert.Equal(JsonValueKind.Null, smart[0].GetProperty("temperatureCelsius").ValueKind);
        Assert.Equal(0, smart[0].GetProperty("reallocatedSectors").GetInt32());
        Assert.False(smart[0].TryGetProperty("receivedUtc", out _));
        Assert.Equal(old, smart[1].GetProperty("observedUtc").GetDateTimeOffset());
        Assert.True(smart[1].GetProperty("aggregated").GetBoolean());
    }

    [Fact]
    public async Task Projection_caps_volume_and_smart_rows()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        await _factory.WithDbAsync(async db =>
        {
            var version = new InventoryVersion { CabinetId = cabinet.Id, FirstObservedUtc = DateTimeOffset.UtcNow.AddDays(-2), LastObservedUtc = DateTimeOffset.UtcNow,
                ContentHash = "many", PayloadJson = JsonSerializer.Serialize(new { disks = Enumerable.Range(0, 80).Select(_ => new { freePercent = 11 }) }) };
            db.InventoryVersions.Add(version);
            (await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id)).CurrentInventoryVersionId = version.Id;
            db.SmartReadings.AddRange(Enumerable.Range(0, 80).Select(i => new SmartReading
            { CabinetId = cabinet.Id, DriveSerial = $"secret-{i}", TimestampUtc = DateTimeOffset.UtcNow.AddMinutes(-i) }));
            await db.SaveChangesAsync();
        });
        var json = await (await support.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        Assert.Equal(32, json.GetProperty("volumes").GetArrayLength());
        Assert.Equal(32, json.GetProperty("smart").GetArrayLength());
    }

    [Fact]
    public async Task Equal_timestamp_rollups_do_not_displace_other_drives()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        var observed = DateTimeOffset.UtcNow.AddHours(-1);
        await _factory.WithDbAsync(async db =>
        {
            db.SmartReadings.AddRange(Enumerable.Range(0, 150).Select(i => new SmartReading
            { CabinetId = cabinet.Id, DriveSerial = "repeated", TimestampUtc = observed,
                IsAggregated = true, TemperatureCelsius = 70 }));
            db.SmartReadings.Add(new SmartReading
            { CabinetId = cabinet.Id, DriveSerial = "repeated", TimestampUtc = observed,
                IsAggregated = false, TemperatureCelsius = 30 });
            db.SmartReadings.Add(new SmartReading
            { CabinetId = cabinet.Id, DriveSerial = "other", TimestampUtc = observed.AddMinutes(-1),
                IsAggregated = false, PendingSectorCount = 4 });
            await db.SaveChangesAsync();
        });
        var json = await (await support.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        var rows = json.GetProperty("smart").EnumerateArray().ToArray();
        Assert.Equal(2, rows.Length);
        Assert.Equal(30, rows[0].GetProperty("temperatureCelsius").GetInt32());
        Assert.False(rows[0].GetProperty("aggregated").GetBoolean());
        Assert.Equal(4, rows[1].GetProperty("pendingSectors").GetInt32());
    }

    [Fact]
    public async Task Oversized_inventory_is_not_loaded_into_response()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        await _factory.WithDbAsync(async db =>
        {
            var version = new InventoryVersion { CabinetId = cabinet.Id, FirstObservedUtc = DateTimeOffset.UtcNow,
                LastObservedUtc = DateTimeOffset.UtcNow, ContentHash = "oversized",
                PayloadJson = "{\"disks\":[{\"freePercent\":99}],\"secret\":\"" + new string('x', 300000) + "\"}" };
            db.InventoryVersions.Add(version);
            (await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id)).CurrentInventoryVersionId = version.Id;
            await db.SaveChangesAsync();
        });
        var json = await (await support.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        Assert.Empty(json.GetProperty("volumes").EnumerateArray());
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("1")]
    public async Task Non_object_inventory_is_unknown_not_an_endpoint_failure(string payload)
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        await _factory.WithDbAsync(async db =>
        {
            var version = new InventoryVersion { CabinetId = cabinet.Id, FirstObservedUtc = DateTimeOffset.UtcNow,
                LastObservedUtc = DateTimeOffset.UtcNow, ContentHash = "non-object", PayloadJson = payload };
            db.InventoryVersions.Add(version);
            (await db.Cabinets.SingleAsync(c => c.Id == cabinet.Id)).CurrentInventoryVersionId = version.Id;
            await db.SaveChangesAsync();
        });
        var response = await support.GetAsync($"/api/cabinets/{cabinet.Id}/storage");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.ReadAsync<JsonElement>();
        Assert.Empty(json.GetProperty("volumes").EnumerateArray());
    }

    [Fact]
    public async Task Storage_is_support_only_and_successfully_audited()
    {
        var (support, user) = await TestClient.CreateUserClientAsync(_factory, Role.Tier2, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, Guid.NewGuid().ToString(), user.Id);
        string url = $"/api/cabinets/{cabinet.Id}/storage";
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync(url)).StatusCode);
        var (inactive, _) = await TestClient.CreateUserClientAsync(_factory, Role.Tier1, Guid.NewGuid().ToString(), isActive: false);
        Assert.NotEqual(HttpStatusCode.OK, (await inactive.GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await support.GetAsync($"/api/cabinets/{Guid.NewGuid()}/storage")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await support.GetAsync(url)).StatusCode);
        Assert.True(await _factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().AnyAsync(a => a.CabinetId == cabinet.Id && a.ActorId == user.Id.ToString() && a.Event == AuditEvent.ViewCabinetLatest && a.Result == AuditResult.Success)));
    }
}
