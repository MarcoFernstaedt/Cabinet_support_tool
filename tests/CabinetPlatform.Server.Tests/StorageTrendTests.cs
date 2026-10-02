using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class StorageTrendTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory factory;
    public StorageTrendTests(SupportApiFactory factory) => this.factory = factory;

    [Fact]
    public async Task Snapshot_selector_reads_bounded_history_without_disclosing_identity()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var stamp = DateTimeOffset.UtcNow.AddDays(-2);
        await factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = stamp, ReceivedUtc = stamp.AddDays(1) });
            db.SmartReadings.Add(new SmartReading { CabinetId = cabinet.Id, DriveSerial = "private-drive-identifier", DriveModel = "private-model", TimestampUtc = stamp, ReallocatedSectorCount = 0 });
            await db.SaveChangesAsync();
        });
        var snapshot = await (await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        var selector = snapshot.GetProperty("smart")[0].GetProperty("driveSelector").GetString();
        Assert.NotNull(selector);
        Assert.DoesNotContain("private-drive-identifier", selector);
        var response = await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage/trends?driveSelector={Uri.EscapeDataString(selector)}&from={Uri.EscapeDataString(stamp.AddHours(-1).ToString("O"))}&to={Uri.EscapeDataString(stamp.AddHours(1).ToString("O"))}&pageSize=1");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("private-drive-identifier", raw);
        Assert.DoesNotContain("private-model", raw);
        var page = JsonDocument.Parse(raw).RootElement;
        var row = page.GetProperty("items")[0];
        Assert.Equal(stamp, row.GetProperty("observedUtc").GetDateTimeOffset());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("receivedUtc").ValueKind);
        Assert.Equal(0, row.GetProperty("reallocatedSectors").GetInt32());
    }

    [Fact]
    public async Task Accepted_smart_keeps_its_own_receipt_after_heartbeat_deletion_and_same_time_replay()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var agent = TestClient.CreateAgentClient(factory, cabinet.MachineId);
        var stamp = DateTimeOffset.UtcNow.AddDays(-2);
        CheckInPayload Payload(int temperature) => new()
        {
            MachineId = cabinet.MachineId, CabinetId = cabinet.Id, AgentVersion = "test",
            CollectedAtUtc = stamp,
            Disks = new[] { new DiskInfo { DriveLetter = "C:", BitLockerStatus = BitLockerStatus.Unknown, HealthStatus = DiskHealthStatus.Healthy,
                Smart = new SmartInfo { SerialNumber = "private-drive", Source = SmartSource.StorageReliabilityCounter,
                    TemperatureCelsius = temperature } } }
        };
        Assert.Equal(HttpStatusCode.OK, (await agent.PostAsJsonAsync("/api/agent/checkin/full", Payload(30))).StatusCode);
        var original = await factory.WithDbAsync(db => db.SmartReadings.AsNoTracking()
            .SingleAsync(s => s.CabinetId == cabinet.Id));
        var receipt = await factory.WithDbAsync(db => db.Heartbeats.AsNoTracking()
            .Where(h => h.CabinetId == cabinet.Id).Select(h => h.ReceivedUtc).SingleAsync());
        await factory.WithDbAsync(async db =>
        {
            await db.Heartbeats.Where(h => h.CabinetId == cabinet.Id).ExecuteDeleteAsync();
            // A pre-upgrade reading can share the same sample time without known provenance.
            db.SmartReadings.Add(new SmartReading { CabinetId = cabinet.Id, DriveSerial = "private-drive",
                TimestampUtc = stamp, TemperatureCelsius = 10 });
            await db.SaveChangesAsync();
        });
        await Task.Delay(50);
        Assert.Equal(HttpStatusCode.OK, (await agent.PostAsJsonAsync("/api/agent/checkin/full", Payload(40))).StatusCode);
        var snapshot = await (await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        string selector = snapshot.GetProperty("smart")[0].GetProperty("driveSelector").GetString()!;
        var page = await (await client.GetAsync(Url(cabinet.Id, selector, stamp.AddMinutes(-1), stamp.AddMinutes(1)))).ReadAsync<JsonElement>();
        var rows = page.GetProperty("items").EnumerateArray().ToArray();
        Assert.Equal(3, rows.Length);
        Assert.Equal(receipt, rows.Single(r => r.GetProperty("temperatureCelsius").GetInt32() == 30)
            .GetProperty("receivedUtc").GetDateTimeOffset());
        Assert.Equal(JsonValueKind.Null, rows.Single(r => r.GetProperty("temperatureCelsius").GetInt32() == 10)
            .GetProperty("receivedUtc").ValueKind);
        Assert.True(rows.Single(r => r.GetProperty("temperatureCelsius").GetInt32() == 40)
            .GetProperty("receivedUtc").GetDateTimeOffset() > receipt);
        Assert.Equal(original.Id, await factory.WithDbAsync(db => db.SmartReadings.AsNoTracking()
            .Where(s => s.CabinetId == cabinet.Id && s.TemperatureCelsius == 30).Select(s => s.Id).SingleAsync()));
    }

    [Fact]
    public async Task Cursor_does_not_include_smart_accepted_after_its_as_of_receipt()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var stamp = DateTimeOffset.UtcNow.AddDays(-2);
        await factory.WithDbAsync(async db =>
        {
            db.SmartReadings.Add(new SmartReading { CabinetId = cabinet.Id, DriveSerial = "private-drive",
                TimestampUtc = stamp.AddMinutes(1), TemperatureCelsius = 30 });
            await db.SaveChangesAsync();
        });
        var snapshot = await (await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        string selector = snapshot.GetProperty("smart")[0].GetProperty("driveSelector").GetString()!;
        // Another existing row guarantees a continuation; the subsequent accepted row predates both.
        await factory.WithDbAsync(async db =>
        {
            db.SmartReadings.Add(new SmartReading { CabinetId = cabinet.Id, DriveSerial = "private-drive",
                TimestampUtc = stamp, TemperatureCelsius = 31 });
            await db.SaveChangesAsync();
        });
        var first = await (await client.GetAsync(Url(cabinet.Id, selector, stamp.AddMinutes(-2), stamp.AddMinutes(2), 1)))
            .ReadAsync<JsonElement>();
        string cursor = first.GetProperty("nextCursor").GetString()!;
        var agent = TestClient.CreateAgentClient(factory, cabinet.MachineId);
        var payload = new CheckInPayload { MachineId = cabinet.MachineId, CabinetId = cabinet.Id,
            AgentVersion = "test", CollectedAtUtc = stamp.AddMinutes(-1),
            Disks = new[] { new DiskInfo { DriveLetter = "C:", BitLockerStatus = BitLockerStatus.Unknown,
                HealthStatus = DiskHealthStatus.Healthy, Smart = new SmartInfo { SerialNumber = "private-drive",
                    Source = SmartSource.StorageReliabilityCounter, TemperatureCelsius = 99 } } } };
        Assert.Equal(HttpStatusCode.OK, (await agent.PostAsJsonAsync("/api/agent/checkin/full", payload)).StatusCode);
        var rest = await (await client.GetAsync(Url(cabinet.Id, selector, stamp.AddMinutes(-2), stamp.AddMinutes(2), 10, cursor)))
            .ReadAsync<JsonElement>();
        Assert.Equal(31, Assert.Single(rest.GetProperty("items").EnumerateArray())
            .GetProperty("temperatureCelsius").GetInt32());
    }

    private static string Url(Guid cabinet, string selector, DateTimeOffset from, DateTimeOffset to, int size = 20, string? cursor = null) =>
        $"/api/cabinets/{cabinet}/storage/trends?driveSelector={Uri.EscapeDataString(selector)}&from={Uri.EscapeDataString(from.ToString("O"))}&to={Uri.EscapeDataString(to.ToString("O"))}&pageSize={size}" +
        (cursor is null ? "" : $"&nextCursor={Uri.EscapeDataString(cursor)}");

    [Fact]
    public async Task Cursor_pages_equal_timestamps_and_refuses_tampering_and_scope_changes()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var other = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var when = DateTimeOffset.UtcNow.AddDays(-2);
        await factory.WithDbAsync(async db =>
        {
            db.SmartReadings.AddRange(Enumerable.Range(0, 4).Select(i => new SmartReading
            { CabinetId = cabinet.Id, DriveSerial = "hidden-serial", TimestampUtc = when, TemperatureCelsius = i }));
            await db.SaveChangesAsync();
        });
        var snapshot = await (await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        string selector = snapshot.GetProperty("smart")[0].GetProperty("driveSelector").GetString()!;
        var from = when.AddMinutes(-1);
        var to = when.AddMinutes(1);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(other.Id, selector, from, to))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(cabinet.Id, selector + "x", from, to))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(cabinet.Id, selector, from, to.AddDays(91)))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(cabinet.Id, selector, from, to, 51))).StatusCode);
        var seen = new List<int>();
        string? cursor = null;
        for (var i = 0; i < 4; i++)
        {
            var response = await client.GetAsync(Url(cabinet.Id, selector, from, to, 1, cursor));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var page = await response.ReadAsync<JsonElement>();
            seen.Add(page.GetProperty("items")[0].GetProperty("temperatureCelsius").GetInt32());
            cursor = page.GetProperty("nextCursor").GetString();
            if (i == 0)
            {
                Assert.NotNull(cursor);
                Assert.DoesNotContain("hidden-serial", cursor);
                Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(cabinet.Id, selector, from.AddSeconds(1), to, 1, cursor))).StatusCode);
                string tampered = cursor![..^1] + (cursor[^1] == 'A' ? "B" : "A");
                Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(cabinet.Id, selector, from, to, 1, tampered))).StatusCode);
            }
        }
        Assert.Null(cursor);
        Assert.Equal(4, seen.Distinct().Count());
    }

    [Fact]
    public async Task Receipt_is_null_for_rollups_and_deleted_heartbeat_but_zero_counters_survive()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var when = DateTimeOffset.UtcNow.AddDays(-3);
        await factory.WithDbAsync(async db =>
        {
            db.Heartbeats.Add(new Heartbeat { CabinetId = cabinet.Id, CollectedAtUtc = when, ReceivedUtc = when.AddDays(2), IsAggregated = true });
            db.SmartReadings.AddRange(
                new SmartReading { CabinetId = cabinet.Id, DriveSerial = "secret", TimestampUtc = when, IsAggregated = true, ReallocatedSectorCount = 0 },
                new SmartReading { CabinetId = cabinet.Id, DriveSerial = "secret", TimestampUtc = when.AddHours(1), PendingSectorCount = null });
            await db.SaveChangesAsync();
        });
        var snapshot = await (await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        var selector = snapshot.GetProperty("smart")[0].GetProperty("driveSelector").GetString()!;
        var page = await (await client.GetAsync(Url(cabinet.Id, selector, when.AddMinutes(-1), when.AddHours(2)))).ReadAsync<JsonElement>();
        var items = page.GetProperty("items").EnumerateArray().ToArray();
        Assert.Equal(2, items.Length);
        Assert.All(items, row => Assert.Equal(JsonValueKind.Null, row.GetProperty("receivedUtc").ValueKind));
        Assert.Equal(JsonValueKind.Null, items[0].GetProperty("pendingSectors").ValueKind);
        Assert.Equal(0, items[1].GetProperty("reallocatedSectors").GetInt32());
        Assert.True(items[1].GetProperty("aggregated").GetBoolean());
    }

    [Fact]
    public async Task Trend_requires_support_and_rejects_absent_or_cross_cabinet_selector()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var cabinet = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var other = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var when = DateTimeOffset.UtcNow.AddDays(-1);
        await factory.WithDbAsync(async db =>
        {
            db.SmartReadings.Add(new SmartReading { CabinetId = cabinet.Id, DriveSerial = "hidden", TimestampUtc = when });
            await db.SaveChangesAsync();
        });
        var snapshot = await (await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage")).ReadAsync<JsonElement>();
        string selector = snapshot.GetProperty("smart")[0].GetProperty("driveSelector").GetString()!;
        var url = Url(cabinet.Id, selector, when.AddMinutes(-1), when.AddMinutes(1));
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync(url)).StatusCode);
        var (inactive, _) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString(), isActive: false);
        Assert.NotEqual(HttpStatusCode.OK, (await inactive.GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(other.Id, selector, when.AddMinutes(-1), when.AddMinutes(1)))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Url(cabinet.Id, "absent", when.AddMinutes(-1), when.AddMinutes(1)))).StatusCode);
        Assert.True(await factory.WithDbAsync(db => db.AuditEntries.AsNoTracking().AnyAsync(a =>
            a.CabinetId == cabinet.Id && a.ActorId == user.Id.ToString() &&
            a.Event == AuditEvent.ViewSmartHistory && a.Result == AuditResult.Denied)));
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync($"/api/cabinets/{cabinet.Id}/storage/trends?driveSelector={Uri.EscapeDataString(selector)}")).StatusCode);
    }
}
