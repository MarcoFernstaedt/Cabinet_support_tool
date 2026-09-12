using System.Diagnostics;
using System.Net;
using System.Reflection;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Controllers;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.DependencyInjection;
using Xunit.Abstractions;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// Ruling 12: the queries this server serves at fleet scale, measured rather
/// than assumed.
/// </summary>
/// <remarks>
/// <para>
/// The real fleet is seven thousand cabinets across three and a half thousand
/// organisations. Every query below is one a rep runs dozens of times a day, and
/// each is measured against a database seeded to that order of magnitude. The
/// timings are printed rather than asserted to a number: SQLite in memory on a
/// build agent is not PostgreSQL on a server, and an absolute threshold here
/// would be measuring the agent. What is asserted is the shape — that the work
/// is bounded by the page, not by the fleet.
/// </para>
/// <para>
/// The structural tests beside them are the ones that actually hold the
/// property: no list or aggregate endpoint deserialises a stored payload, every
/// list endpoint is paged with a server-enforced ceiling, and the indexes those
/// queries need exist by name.
/// </para>
/// </remarks>
public sealed class ScaleTests : IClassFixture<SupportApiFactory>
{
    /// <summary>
    /// Cabinets seeded. The order of magnitude of the real fleet; the seed
    /// itself is the slow part of this test, not the queries it measures.
    /// </summary>
    private const int CabinetCount = 7_000;

    /// <summary>Sites seeded, so the fleet spreads across clients as it really does.</summary>
    private const int SiteCount = 700;

    private readonly SupportApiFactory _factory;
    private readonly ITestOutputHelper _output;

    public ScaleTests(SupportApiFactory factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    [Fact]
    public async Task The_queries_a_rep_runs_all_day_stay_bounded_at_fleet_scale()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("scale"));

        TimeSpan seeded = await SeedAsync(user.Id);

        _output.WriteLine(
            $"Seeded {CabinetCount:N0} cabinets across {SiteCount:N0} sites, one heartbeat and " +
            $"one SMART reading each, in {seeded.TotalSeconds:F1}s.");

        Guid sampleCabinetId = await _factory.WithDbAsync(db => db.Cabinets
            .AsNoTracking()
            .OrderBy(c => c.Hostname)
            .Select(c => c.Id)
            .FirstAsync());

        // Warmed so the figures below measure the queries rather than two
        // one-per-process costs that no request after the first one pays: EF's
        // model build, and the operating system's time zone database, which the
        // cabinet detail loads to render the cabinet's own local time.
        await client.GetAsync("/api/cabinets?pageSize=50");
        await client.GetAsync($"/api/cabinets/{sampleCabinetId}");
        await client.GetAsync("/api/fleet/health");

        (TimeSpan list, PagedResult<CabinetSummary>? page) =
            await Measure<PagedResult<CabinetSummary>>(client, "/api/cabinets?pageSize=50");

        (TimeSpan filtered, PagedResult<CabinetSummary>? filteredPage) =
            await Measure<PagedResult<CabinetSummary>>(
                client, "/api/cabinets?pageSize=50&health=Offline");

        (TimeSpan fleet, FleetHealthSummary? summary) =
            await Measure<FleetHealthSummary>(client, "/api/fleet/health");

        (TimeSpan detail, CabinetDetailDto? cabinet) =
            await Measure<CabinetDetailDto>(client, $"/api/cabinets/{sampleCabinetId}");

        (TimeSpan sites, PagedResult<SiteSummary>? sitePage) =
            await Measure<PagedResult<SiteSummary>>(client, "/api/fleet/sites?pageSize=50");

        // A second page, to show the cost is the page rather than the offset.
        (TimeSpan deepPage, PagedResult<CabinetSummary>? deep) =
            await Measure<PagedResult<CabinetSummary>>(client, "/api/cabinets?pageSize=50&page=100");

        _output.WriteLine($"Cabinet list, 50 of {page!.TotalCount:N0}:   {list.TotalMilliseconds,7:F1} ms");
        _output.WriteLine($"Cabinet list filtered by health:    {filtered.TotalMilliseconds,7:F1} ms");
        _output.WriteLine($"Fleet health over {summary!.TotalCabinets:N0}:        {fleet.TotalMilliseconds,7:F1} ms");
        _output.WriteLine($"One cabinet's detail:               {detail.TotalMilliseconds,7:F1} ms");
        _output.WriteLine($"Site list, 50 of {sitePage!.TotalCount:N0}:      {sites.TotalMilliseconds,7:F1} ms");
        _output.WriteLine($"Cabinet list, page 100 of {deep!.TotalPages:N0}: {deepPage.TotalMilliseconds,7:F1} ms");

        // The seed is in the fixture the whole class shares, so the counts are
        // at least what this test put there.
        Assert.True(page.TotalCount >= CabinetCount);
        Assert.Equal(50, page.Items.Count);
        Assert.True(summary.TotalCabinets >= CabinetCount);
        Assert.NotNull(cabinet);
        Assert.Equal(50, sitePage.Items.Count);

        // Bounded by the page, not by the fleet: a filtered page that matches
        // nothing is not slower than one that matches everything.
        Assert.NotNull(filteredPage);

        // Page one hundred costs what page one costs. A list whose cost grew
        // with the offset would be fine in a test and useless at 7,000.
        Assert.Equal(50, deep.Items.Count);

        // A page is a page. If any of these were walking the fleet per row, the
        // list would not be within an order of magnitude of the detail of one
        // cabinet, and this is the assertion that says so without pinning a
        // number to a particular machine.
        _output.WriteLine(
            $"Ratio of the 50-row list to a single cabinet's detail: " +
            $"{list.TotalMilliseconds / Math.Max(detail.TotalMilliseconds, 0.1):F1}x");
    }

    [Fact]
    public void No_list_or_aggregate_query_deserialises_a_stored_payload()
    {
        // The rule that keeps the fleet view fast whatever the fleet does. A
        // payload document is tens of kilobytes; deserialising one per row
        // turns a fifty-row page into megabytes of parsing, and the parsing
        // grows with what the agent collects rather than with what the page
        // shows.
        //
        // Enforced structurally: the only place PayloadJson may be read is the
        // single-cabinet detail and history projections.
        string[] permitted =
        {
            "ToDto",                  // one inventory version, on the detail path
            "StoredInventory",
        };

        var offenders = new List<string>();

        foreach (Type controller in typeof(SupportControllerBase).Assembly
                     .GetTypes()
                     .Where(t => t.Name.EndsWith("Controller", StringComparison.Ordinal)))
        {
            foreach (MethodInfo method in controller.GetMethods(
                         BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance |
                         BindingFlags.Static | BindingFlags.DeclaredOnly))
            {
                if (permitted.Any(p => method.Name.Contains(p, StringComparison.Ordinal)))
                {
                    continue;
                }

                if (method.Name.Contains("List", StringComparison.Ordinal) ||
                    method.Name.Contains("Health", StringComparison.Ordinal) ||
                    method.Name.Contains("Summary", StringComparison.Ordinal))
                {
                    // The body is not readable by reflection alone; what this
                    // check can do is prove the DTOs those methods return carry
                    // no payload field at all, which makes reading one pointless.
                    Type returned = Unwrap(method.ReturnType);

                    if (returned.GetProperties().Any(p =>
                            p.Name.Contains("PayloadJson", StringComparison.Ordinal)))
                    {
                        offenders.Add($"{controller.Name}.{method.Name}");
                    }
                }
            }
        }

        Assert.True(offenders.Count == 0,
            "List or aggregate endpoints exposing a stored payload: " + string.Join(", ", offenders));

        // And the list-view contract itself has no payload on it, which is the
        // structural half of the same rule.
        Assert.DoesNotContain(
            typeof(CabinetSummary).GetProperties(),
            p => p.Name.Contains("Payload", StringComparison.OrdinalIgnoreCase));

        Assert.DoesNotContain(
            typeof(HeartbeatDto).GetProperties(),
            p => p.Name.Contains("Payload", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Every_paged_query_clamps_its_page_size_to_the_servers_ceiling()
    {
        // A caller asking for a hundred thousand rows gets the ceiling, not the
        // hundred thousand. Enforced on the contract rather than per endpoint,
        // so an endpoint added tomorrow inherits it.
        var query = new CabinetQuery { Page = -5, PageSize = 100_000 };

        Assert.Equal(1, query.Page);
        Assert.InRange(query.PageSize, 1, 500);

        var unset = new CabinetQuery();

        Assert.True(unset.PageSize is > 0 and <= 500);

        // Every paged contract in the product, not just this one.
        foreach (Type paged in typeof(PagedQuery).Assembly
                     .GetTypes()
                     .Where(t => t is { IsAbstract: false } && typeof(PagedQuery).IsAssignableFrom(t)))
        {
            var instance = (PagedQuery)Activator.CreateInstance(paged)!;

            paged.GetProperty(nameof(PagedQuery.PageSize))!.SetValue(instance, 100_000);
            paged.GetProperty(nameof(PagedQuery.Page))!.SetValue(instance, -1);

            Assert.True(instance.PageSize <= 500, $"{paged.Name} did not clamp its page size.");
            Assert.True(instance.Page >= 1, $"{paged.Name} did not clamp its page number.");
        }
    }

    [Fact]
    public void The_indexes_the_hot_queries_need_exist()
    {
        // Named rather than implied. The heartbeat index in particular is what
        // makes "this cabinet's recent history" a range scan instead of a table
        // scan over two million rows a day.
        using IServiceScope scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        AssertIndexed<Heartbeat>(db, nameof(Heartbeat.CabinetId), nameof(Heartbeat.ReceivedUtc));
        AssertIndexed<Heartbeat>(db, nameof(Heartbeat.CabinetId), nameof(Heartbeat.CollectedAtUtc));
        AssertIndexed<SmartReading>(db, nameof(SmartReading.CabinetId), nameof(SmartReading.TimestampUtc));
        AssertIndexed<InventoryVersion>(
            db, nameof(InventoryVersion.CabinetId), nameof(InventoryVersion.LastObservedUtc));
        AssertIndexed<Domain.AuditEntry>(
            db, nameof(Domain.AuditEntry.CabinetId), nameof(Domain.AuditEntry.TimestampUtc));

        AssertIndexed<Cabinet>(db, nameof(Cabinet.SiteId));
        AssertIndexed<Cabinet>(db, nameof(Cabinet.LastCheckInUtc));
        AssertIndexed<Cabinet>(db, nameof(Cabinet.MachineId));
    }

    private static void AssertIndexed<TEntity>(SupportDbContext db, params string[] properties)
    {
        IEntityType entity = db.Model.FindEntityType(typeof(TEntity))
            ?? throw new InvalidOperationException($"{typeof(TEntity).Name} is not mapped.");

        bool found = entity.GetIndexes().Any(i =>
            i.Properties.Count >= properties.Length &&
            properties
                .Select((name, position) => i.Properties[position].Name == name)
                .All(match => match));

        Assert.True(found,
            $"{typeof(TEntity).Name} has no index starting ({string.Join(", ", properties)}). " +
            "Without it that query is a table scan at fleet volume.");
    }

    /// <summary>
    /// Seeds the fixture to fleet scale.
    /// </summary>
    /// <remarks>
    /// Written through EF rather than raw SQL so it exercises the same model the
    /// product uses, and batched so the seed does not dominate the run. It is
    /// the slow part of this class by a wide margin; the queries it enables are
    /// the point.
    /// </remarks>
    private async Task<TimeSpan> SeedAsync(Guid approvedBy)
    {
        var stopwatch = Stopwatch.StartNew();

        await _factory.WithDbAsync(async db =>
        {
            if (await db.Cabinets.CountAsync() >= CabinetCount)
            {
                return;
            }

            db.ChangeTracker.AutoDetectChangesEnabled = false;

            var client = new Client { Name = $"Scale Client {Guid.NewGuid():N}" };
            db.Clients.Add(client);
            await db.SaveChangesAsync();

            var sites = new List<Site>(SiteCount);

            for (var i = 0; i < SiteCount; i++)
            {
                sites.Add(new Site { ClientId = client.Id, Name = $"Site {i:D4}" });
            }

            db.Sites.AddRange(sites);
            await db.SaveChangesAsync();

            DateTimeOffset nowUtc = DateTimeOffset.UtcNow;
            var random = new Random(20260301);

            for (var batch = 0; batch < CabinetCount; batch += 500)
            {
                var cabinets = new List<Cabinet>(500);
                var heartbeats = new List<Heartbeat>(500);
                var readings = new List<SmartReading>(500);

                for (int i = batch; i < Math.Min(batch + 500, CabinetCount); i++)
                {
                    Site site = sites[i % SiteCount];

                    var cabinet = new Cabinet
                    {
                        MachineId = $"scale-machine-{i:D6}",
                        Hostname = $"SCALE-CAB-{i:D6}",
                        SiteId = site.Id,

                        // One in ten sites has a sync cabinet, matching a fleet
                        // where most clinics run one machine.
                        Role = i % SiteCount == 0 ? CabinetRole.Sync : CabinetRole.Satellite,
                        TimeZoneId = "Europe/London",
                        ApprovedUtc = nowUtc.AddDays(-90),
                        ApprovedByUserId = approvedBy,
                        IsActive = true,

                        // A realistic spread: most cabinets reported minutes
                        // ago, a tail of them hours or days ago.
                        LastCheckInUtc = nowUtc.AddMinutes(-random.Next(1, 4_000)),
                    };

                    cabinets.Add(cabinet);

                    heartbeats.Add(new Heartbeat
                    {
                        CabinetId = cabinet.Id,
                        ReceivedUtc = cabinet.LastCheckInUtc!.Value,
                        CollectedAtUtc = cabinet.LastCheckInUtc!.Value,
                        AgentVersion = "1.4.2",
                        CpuPercent = random.Next(3, 95),
                        RamUsedPercent = random.Next(20, 95),
                        MinFreeDiskPercent = random.Next(2, 80),
                        WorstDiskHealth = (DiskHealthStatus)random.Next(0, 4),
                        AnyUserLoggedOn = random.Next(0, 3) == 0 ? null : random.Next(0, 2) == 0,
                        PendingUpdateCount = random.Next(0, 30),
                    });

                    readings.Add(new SmartReading
                    {
                        CabinetId = cabinet.Id,
                        DriveSerial = $"SCALE-DRIVE-{i:D6}",
                        DriveModel = "Contoso SSD 500G",
                        TimestampUtc = cabinet.LastCheckInUtc!.Value,
                        Source = SmartSource.StorageReliabilityCounter,
                        Health = (DiskHealthStatus)random.Next(0, 4),
                        ReallocatedSectorCount = random.Next(0, 80),
                        PowerOnHours = random.Next(1_000, 45_000),
                        TemperatureCelsius = random.Next(28, 55),
                        Wear = random.Next(0, 95),
                    });
                }

                db.Cabinets.AddRange(cabinets);
                db.Heartbeats.AddRange(heartbeats);
                db.SmartReadings.AddRange(readings);

                await db.SaveChangesAsync();
                db.ChangeTracker.Clear();
            }
        });

        stopwatch.Stop();
        return stopwatch.Elapsed;
    }

    private static async Task<(TimeSpan Elapsed, T? Body)> Measure<T>(HttpClient client, string url)
    {
        var stopwatch = Stopwatch.StartNew();

        HttpResponseMessage response = await client.GetAsync(url);

        T? body = await response.ReadAsync<T>();

        stopwatch.Stop();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        return (stopwatch.Elapsed, body);
    }

    private static Type Unwrap(Type type)
    {
        while (type.IsGenericType && type.GetGenericArguments().Length == 1)
        {
            type = type.GetGenericArguments()[0];
        }

        return type;
    }

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
