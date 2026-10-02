using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

public sealed class ConnectivityHistoryTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory factory;
    public ConnectivityHistoryTests(SupportApiFactory factory) => this.factory = factory;

    [Fact]
    public async Task Bounded_history_projects_only_accepted_rows_and_pins_pages()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var source = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var other = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var target = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow.AddSeconds(-1);
        var observed = now.AddMinutes(-4);
        var ids = Enumerable.Range(0, 22).Select(_ => Guid.NewGuid()).ToArray();
        await factory.WithDbAsync(async db =>
        {
            foreach (var id in ids) db.ConnectivityEvidence.Add(Evidence(id, source.Id, target, observed));
            db.ConnectivityEvidence.Add(Evidence(Guid.NewGuid(), other.Id, target, observed));
            db.ConnectivityEvidence.Add(Evidence(Guid.NewGuid(), source.Id, Guid.NewGuid(), observed));
            await db.SaveChangesAsync();
        });
        string url = $"/api/connectivity/cabinets/{source.Id}/history?targetId={target}&from={Uri.EscapeDataString(now.AddHours(-1).ToString("O"))}&to={Uri.EscapeDataString(now.ToString("O"))}";
        var firstResponse = await client.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, firstResponse.StatusCode);
        var first = await firstResponse.ReadAsync<JsonElement>();
        Assert.Equal(source.Id, first.GetProperty("sourceCabinetId").GetGuid());
        Assert.Equal(target, first.GetProperty("targetCabinetId").GetGuid());
        Assert.Equal(20, first.GetProperty("items").GetArrayLength());
        Assert.Equal(now.AddHours(-1), first.GetProperty("fromUtc").GetDateTimeOffset());
        Assert.Equal(now, first.GetProperty("toUtc").GetDateTimeOffset());
        var cursor = first.GetProperty("nextCursor").GetString();
        Assert.False(string.IsNullOrWhiteSpace(cursor));
        // A row received after the first page must not appear on the pinned continuation.
        await factory.WithDbAsync(async db =>
        {
            var late = Evidence(Guid.NewGuid(), source.Id, target, observed);
            late.ReceivedUtc = first.GetProperty("asOfUtc").GetDateTimeOffset().AddTicks(1);
            db.ConnectivityEvidence.Add(late);
            await db.SaveChangesAsync();
        });
        var second = await (await client.GetAsync(url + "&nextCursor=" + Uri.EscapeDataString(cursor!))).ReadAsync<JsonElement>();
        Assert.Equal(2, second.GetProperty("items").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, second.GetProperty("nextCursor").ValueKind);
        var returned = first.GetProperty("items").EnumerateArray().Concat(second.GetProperty("items").EnumerateArray()).Select(x => x.GetProperty("id").GetGuid()).ToArray();
        Assert.Equal(ids.OrderByDescending(x => x).ToArray(), returned);
        Assert.All(first.GetProperty("items").EnumerateArray(), row =>
        {
            Assert.Equal(target, row.GetProperty("targetCabinetId").GetGuid());
            Assert.Equal(0, row.GetProperty("errorCount").GetInt32());
            Assert.False(row.TryGetProperty("summaryJson", out _));
        });
        var tampered = cursor![..^1] + (cursor[^1] == 'X' ? "Y" : "X");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(url + "&nextCursor=" + Uri.EscapeDataString(tampered))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync($"/api/connectivity/cabinets/{other.Id}/history?nextCursor={Uri.EscapeDataString(cursor!)}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync(url)).StatusCode);
    }

    [Fact]
    public async Task Rejects_unbounded_and_invalid_windows()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var source = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var baseUrl = $"/api/connectivity/cabinets/{source.Id}/history";
        foreach (var suffix in new[] { "?from=2020-01-01T00:00:00Z", "?from=2020-01-01T00:00:00Z&to=2020-02-02T00:00:00Z", "?pageSize=51", "?targetId=not-a-guid", "?nextCursor=bogus" })
            Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(baseUrl + suffix)).StatusCode);
    }

    [Fact]
    public async Task History_keeps_reply_nonreply_and_error_distinct_and_hides_corrupt_summaries()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var source = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var target = Guid.NewGuid();
        var observed = DateTimeOffset.UtcNow.AddMinutes(-5);
        var reply = Evidence(Guid.NewGuid(), source.Id, target, observed);
        var nonreply = Evidence(Guid.NewGuid(), source.Id, target, observed.AddMinutes(-4));
        var gap = Evidence(Guid.NewGuid(), source.Id, target, observed.AddMinutes(-8));
        var corrupt = Evidence(Guid.NewGuid(), source.Id, target, observed.AddMinutes(-12));
        reply.SummaryJson = JsonSerializer.Serialize(new { reply.Id, reply.SourceCabinetId, reply.TargetCabinetId,
            reply.ConfigurationId, reply.FirstObservedUtc, LastObservedUtc = reply.ObservedUtc,
            SuccessCount = 3, FailureCount = 0, ErrorCount = 0, LeadingFailures = 0, TrailingFailures = 0,
            MaximumFailureRun = 0, LastSuccessUtc = reply.ObservedUtc });
        gap.SummaryJson = JsonSerializer.Serialize(new { gap.Id, gap.SourceCabinetId, gap.TargetCabinetId,
            gap.ConfigurationId, gap.FirstObservedUtc, LastObservedUtc = gap.ObservedUtc,
            SuccessCount = 0, FailureCount = 0, ErrorCount = 3, LeadingFailures = 0, TrailingFailures = 0,
            MaximumFailureRun = 0 });
        corrupt.SummaryJson = "{\"patient\":\"do not expose\",";
        await factory.WithDbAsync(async db => { db.ConnectivityEvidence.AddRange(reply, nonreply, gap, corrupt); await db.SaveChangesAsync(); });
        var response = await client.GetAsync($"/api/connectivity/cabinets/{source.Id}/history");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var page = await response.ReadAsync<JsonElement>();
        var items = page.GetProperty("items").EnumerateArray().ToDictionary(x => x.GetProperty("id").GetGuid());
        Assert.Equal(3, items[reply.Id].GetProperty("successCount").GetInt32());
        Assert.Equal(JsonValueKind.Null, items[reply.Id].GetProperty("lastFailureUtc").ValueKind);
        Assert.Equal(3, items[nonreply.Id].GetProperty("failureCount").GetInt32());
        Assert.Equal(3, items[gap.Id].GetProperty("errorCount").GetInt32());
        Assert.Equal(JsonValueKind.Null, items[corrupt.Id].GetProperty("failureCount").ValueKind);
        Assert.True(items[corrupt.Id].GetProperty("evidenceUnavailable").GetBoolean());
        Assert.DoesNotContain("patient", await response.Content.ReadAsStringAsync());
        Assert.True(await factory.WithDbAsync(db => db.AuditEntries.AnyAsync(a => a.CabinetId == source.Id && a.ActorId == user.Id.ToString())));
    }

    [Fact]
    public async Task Cursor_rejects_target_and_window_scope_changes()
    {
        var (client, user) = await TestClient.CreateUserClientAsync(factory, Role.Tier1, Guid.NewGuid().ToString());
        var source = await TestClient.CreateApprovedCabinetAsync(factory, Guid.NewGuid().ToString(), user.Id);
        var target = Guid.NewGuid();
        var observed = DateTimeOffset.UtcNow.AddMinutes(-3);
        await factory.WithDbAsync(async db =>
        {
            db.ConnectivityEvidence.AddRange(Evidence(Guid.NewGuid(), source.Id, target, observed),
                Evidence(Guid.NewGuid(), source.Id, target, observed.AddMinutes(-3)));
            await db.SaveChangesAsync();
        });
        var url = $"/api/connectivity/cabinets/{source.Id}/history?targetId={target}&pageSize=1";
        var page = await (await client.GetAsync(url)).ReadAsync<JsonElement>();
        var token = Uri.EscapeDataString(page.GetProperty("nextCursor").GetString()!);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(url + "&nextCursor=" + token)).StatusCode);
        foreach (var other in new[] { $"/api/connectivity/cabinets/{source.Id}/history?nextCursor={token}",
            url + $"&from={Uri.EscapeDataString(DateTimeOffset.UtcNow.AddHours(-2).ToString("O"))}&nextCursor={token}",
            $"/api/connectivity/cabinets/{source.Id}/history?targetId={Guid.NewGuid()}&nextCursor={token}" })
            Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(other)).StatusCode);
    }

    private static ConnectivityEvidence Evidence(Guid id, Guid source, Guid target, DateTimeOffset observed)
    {
        var configuration = Guid.NewGuid();
        return new ConnectivityEvidence
        {
        Id = id, SourceCabinetId = source, TargetCabinetId = target, ConfigurationId = configuration,
        FirstObservedUtc = observed.AddMinutes(-2), ObservedUtc = observed, ReceivedUtc = DateTimeOffset.UtcNow.AddMinutes(-1),
        SummaryJson = JsonSerializer.Serialize(new { id, sourceCabinetId = source, targetCabinetId = target,
            configurationId = configuration, firstObservedUtc = observed.AddMinutes(-2), lastObservedUtc = observed,
            successCount = 0, failureCount = 3, errorCount = 0, leadingFailures = 3, trailingFailures = 3,
            maximumFailureRun = 3, lastFailureUtc = observed })
        };
    }
}
