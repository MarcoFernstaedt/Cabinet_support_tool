using System.Data.Common;
using System.Net;
using System.Security.Claims;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Controllers;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetRetirementTopologyConcurrencyTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stale_tracked_context_cannot_restore_retired_sync_or_block_replacement(bool replacement)
    {
        using var f = new SupportApiFactory();
        var (client, user) = await TestClient.CreateUserClientAsync(f, Role.Supervisor, "stale-topology");
        var old = await TestClient.CreateApprovedCabinetAsync(f, "stale-old", user.Id, role: CabinetRole.Sync);
        var target = replacement ? await TestClient.CreateApprovedCabinetAsync(f, "stale-new", user.Id) : old;
        using var scope = f.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        _ = await db.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == target.Id);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{old.Id}/retire", new { Reason = "retire before stale edit" })).StatusCode);
        var controller = ActivatorUtilities.CreateInstance<CabinetsController>(scope.ServiceProvider);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext
        {
            RequestServices = scope.ServiceProvider,
            User = new ClaimsPrincipal(new ClaimsIdentity(new[]
            {
                new Claim(SupportClaims.UserId, user.Id.ToString()),
                new Claim(SupportClaims.Role, Role.Supervisor.ToString()),
                new Claim(ClaimTypes.Name, user.Username)
            }, "test"))
        }};
        var result = await controller.SetRole(target.Id, new SetCabinetRoleRequest { Role = CabinetRole.Sync, Reason = "stale confirmation" }, default);
        Assert.Equal(replacement ? 200 : 409, Assert.IsAssignableFrom<ObjectResult>(result.Result).StatusCode);
        await f.WithDbAsync(async fresh =>
        {
            var saved = await fresh.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == old.Id);
            Assert.False(saved.IsActive);
            Assert.Equal(CabinetRole.Sync, saved.Role);
            Assert.Equal(old.ApprovedUtc, saved.ApprovedUtc);
            Assert.Equal(replacement ? target.Id : (Guid?)null, saved.Site!.SyncCabinetId);
        });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Forced_overlap_serializes_role_and_retirement(bool retireFirst)
    {
        using var baseFactory = new SupportApiFactory();
        var gate = new SaveGate(retireFirst ? AuditEvent.RetireCabinet : AuditEvent.SetCabinetRole);
        var arrival = new TransactionArrival(gate);
        using var factory = baseFactory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            services.AddDbContext<SqliteSupportDbContext>((sp, options) => options
                .UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString).AddInterceptors(gate, arrival));
        }));
        using var client = factory.CreateClient();
        Guid id;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var user = await db.Users.SingleAsync(u => u.Role == Role.Supervisor);
            user.MustChangePassword = false;
            var site = new Site { Name = "Overlap", Client = new Client { Name = "Synthetic" } };
            var cabinet = new Cabinet { MachineId = "overlap", Hostname = "overlap", Site = site,
                Role = CabinetRole.Satellite, ApprovedByUserId = user.Id, ApprovedUtc = DateTimeOffset.UtcNow };
            db.Cabinets.Add(cabinet);
            await db.SaveChangesAsync();
            id = cabinet.Id;
            client.DefaultRequestHeaders.Authorization = new("Bearer", scope.ServiceProvider.GetRequiredService<IJwtTokenService>().Issue(user).AccessToken);
        }
        gate.Armed = true;
        Task<HttpResponseMessage> Edit() => client.PutJsonAsync($"/api/cabinets/{id}/role", new { Role = CabinetRole.Sync, Reason = "overlap edit" });
        Task<HttpResponseMessage> Retire() => client.PostJsonAsync($"/api/cabinets/{id}/retire", new { Reason = "overlap retirement" });
        var first = Task.Run<HttpResponseMessage>(retireFirst ? Retire : Edit);
        Task<HttpResponseMessage>? second = null;
        try
        {
            await gate.Reached.Task.WaitAsync(TimeSpan.FromSeconds(15));
            second = Task.Run<HttpResponseMessage>(retireFirst ? Edit : Retire);
            // The competing request has reached transaction acquisition while
            // the first request is paused after persistence, before commit.
            await arrival.Reached.Task.WaitAsync(TimeSpan.FromSeconds(15));
            Assert.False(second.IsCompleted);
        }
        finally { gate.Release.TrySetResult(); }
        var firstResult = await first.WaitAsync(TimeSpan.FromSeconds(30));
        var secondResult = await second!.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(retireFirst ? HttpStatusCode.NoContent : HttpStatusCode.OK, firstResult.StatusCode);
        Assert.Equal(retireFirst ? HttpStatusCode.Conflict : HttpStatusCode.NoContent, secondResult.StatusCode);
        using var verifyScope = factory.Services.CreateScope();
        var verify = verifyScope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var saved = await verify.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == id);
        Assert.False(saved.IsActive);
        Assert.Null(saved.Site!.SyncCabinetId);
        Assert.Equal(retireFirst ? CabinetRole.Satellite : CabinetRole.Sync, saved.Role);
        var audits = await verify.AuditEntries.Where(a => a.CabinetId == id).ToListAsync();
        Assert.Single(audits, a => a.Event == AuditEvent.RetireCabinet && a.Result == AuditResult.Success);
        Assert.Single(audits, a => a.Event == AuditEvent.SetCabinetRole && a.Result == (retireFirst ? AuditResult.Denied : AuditResult.Success));
    }

    private sealed class SaveGate(AuditEvent target) : SaveChangesInterceptor
    {
        public bool Armed { get; set; }
        public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            if (Armed && eventData.Context!.ChangeTracker.Entries<AuditEntry>().Any(e => e.Entity.Event == target))
            {
                Armed = false;
                Reached.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
            }
            return result;
        }
    }

    private sealed class TransactionArrival(SaveGate gate) : DbTransactionInterceptor
    {
        public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override ValueTask<InterceptionResult<DbTransaction>> TransactionStartingAsync(DbConnection connection,
            TransactionStartingEventData eventData, InterceptionResult<DbTransaction> result, CancellationToken cancellationToken = default)
        {
            if (gate.Reached.Task.IsCompleted) Reached.TrySetResult();
            return ValueTask.FromResult(result);
        }
    }
}
