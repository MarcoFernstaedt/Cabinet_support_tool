using System.Data.Common;
using System.Net;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace CabinetPlatform.Server.Tests;

public sealed class CabinetRetirementAtomicityTests
{
    [Fact]
    public async Task Failure_after_audit_save_rolls_back_retirement_and_sync_designation_then_retry_succeeds()
    {
        using var baseFactory = new SupportApiFactory();
        var failure = new FailAfterRetirementAudit();
        using var factory = baseFactory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            services.AddDbContext<SqliteSupportDbContext>((sp, options) => options
                .UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString).AddInterceptors(failure));
        }));
        using var client = factory.CreateClient();
        Guid id;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var user = await db.Users.SingleAsync(u => u.Role == Role.Supervisor);
            user.MustChangePassword = false;
            var site = new Site { Name = "Atomic synthetic site", Client = new Client { Name = "Atomic synthetic client" } };
            var cabinet = new Cabinet { MachineId = "retirement-atomic", Hostname = "synthetic", Site = site,
                Role = CabinetRole.Sync, ApprovedByUserId = user.Id, ApprovedUtc = DateTimeOffset.UtcNow };
            db.Cabinets.Add(cabinet);
            await db.SaveChangesAsync();
            site.SyncCabinetId = cabinet.Id;
            await db.SaveChangesAsync();
            id = cabinet.Id;
            var token = scope.ServiceProvider.GetRequiredService<IJwtTokenService>().Issue(user);
            client.DefaultRequestHeaders.Authorization = new("Bearer", token.AccessToken);
        }
        failure.Armed = true;
        Assert.Equal(HttpStatusCode.InternalServerError, (await client.PostJsonAsync($"/api/cabinets/{id}/retire", new { Reason = "Atomic retirement" })).StatusCode);
        Assert.True(failure.Fired);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var saved = await db.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == id);
            Assert.True(saved.IsActive);
            Assert.Equal(id, saved.Site!.SyncCabinetId);
            Assert.Empty(await db.AuditEntries.Where(a => a.CabinetId == id && a.Event == AuditEvent.RetireCabinet).ToListAsync());
        }
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostJsonAsync($"/api/cabinets/{id}/retire", new { Reason = "Atomic retirement" })).StatusCode);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var saved = await db.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == id);
            Assert.False(saved.IsActive);
            Assert.Null(saved.Site!.SyncCabinetId);
            Assert.Single(await db.AuditEntries.Where(a => a.CabinetId == id && a.Event == AuditEvent.RetireCabinet).ToListAsync());
        }
    }

    private sealed class FailAfterRetirementAudit : SaveChangesInterceptor
    {
        public bool Armed { get; set; }
        public bool Fired { get; private set; }
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            if (Armed && eventData.Context!.ChangeTracker.Entries<AuditEntry>().Any(e => e.Entity.Event == AuditEvent.RetireCabinet))
            {
                Armed = false;
                Fired = true;
                throw new InvalidOperationException("Synthetic failure after retirement audit save, before commit.");
            }
            return ValueTask.FromResult(result);
        }
    }
}
