using System.Data.Common;
using System.Net;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace CabinetPlatform.Server.Tests;

public sealed class MeasurementConcurrencyTests
{
    [Fact]
    public async Task Older_request_paused_before_save_cannot_overwrite_a_competing_newer_sample()
    {
        using var baseFactory = new SupportApiFactory();
        var pause = new PauseOldSample();
        using var factory = baseFactory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            services.AddDbContext<SqliteSupportDbContext>((sp, options) => options
                .UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString).AddInterceptors(pause));
        }));
        using var agent = factory.CreateClient();
        agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", SupportApiFactory.AgentSharedSecret);
        agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", "concurrent-measurement");
        Guid cabinetId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var client = new Client { Name = "Concurrency lab" };
            var site = new Site { Name = "Lab", Client = client };
            var cabinet = new Cabinet { MachineId = "concurrent-measurement", Hostname = "initial",
                Site = site, ApprovedUtc = DateTimeOffset.UtcNow,
                ApprovedByUserId = (await db.Users.FirstAsync()).Id, IsActive = true };
            db.Cabinets.Add(cabinet);
            await db.SaveChangesAsync();
            cabinetId = cabinet.Id;
        }
        var older = new CheckInPayload { MachineId = "concurrent-measurement", CabinetId = cabinetId,
            AgentVersion = "old", CollectedAtUtc = DateTimeOffset.UtcNow.AddHours(-1),
            System = new SystemInfo { Hostname = "old" } };
        var newer = older with { AgentVersion = "new", CollectedAtUtc = DateTimeOffset.UtcNow.AddMinutes(-1),
            System = new SystemInfo { Hostname = "new" } };
        var oldRequest = agent.PostJsonAsync("/api/agent/checkin/full", older);
        await pause.Reached.Task.WaitAsync(TimeSpan.FromSeconds(15));
        Task<HttpResponseMessage> newRequest;
        try
        {
            newRequest = agent.PostJsonAsync("/api/agent/checkin/full", newer);
            // Without serialization the newer request commits while the old one
            // is paused. With serialization it waits for the old transaction.
            await Task.WhenAny(newRequest, Task.Delay(TimeSpan.FromSeconds(1)));
        }
        finally { pause.Release.TrySetResult(); }
        Assert.Equal(HttpStatusCode.OK, (await oldRequest).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await newRequest).StatusCode);
        using var verify = factory.Services.CreateScope();
        var verifyDb = verify.ServiceProvider.GetRequiredService<SupportDbContext>();
        var stored = await verifyDb.Cabinets.AsNoTracking().SingleAsync(c => c.Id == cabinetId);
        Assert.Equal("new", stored.Hostname);
        Assert.Equal(newer.CollectedAtUtc, stored.LastFullCheckInUtc);
        Assert.Equal(2, await verifyDb.Heartbeats.CountAsync(h => h.CabinetId == cabinetId));
    }

    private sealed class PauseOldSample : SaveChangesInterceptor
    {
        private int _paused;
        public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context!.ChangeTracker.Entries<Heartbeat>().Any(e => e.Entity.AgentVersion == "old")
                && Interlocked.CompareExchange(ref _paused, 1, 0) == 0)
            {
                Reached.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken);
            }
            return result;
        }
    }
}
