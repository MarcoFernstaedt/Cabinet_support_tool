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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Concurrent_supervisors_attribute_retirement_only_to_the_first_committer(bool reverseArrival)
    {
        using var baseFactory = new SupportApiFactory();
        var gate = new PauseAfterRetirementAudit();
        var arrival = new RetirementTransactionArrival(gate);
        using var factory = baseFactory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
            services.AddDbContext<SqliteSupportDbContext>((sp, options) => options
                .UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString).AddInterceptors(gate, arrival));
        }));
        using var firstClient = factory.CreateClient();
        using var secondClient = factory.CreateClient();
        Guid id;
        Guid firstActor;
        Guid secondActor;
        const string firstReason = "Synthetic supervisor alpha decision";
        const string secondReason = "Synthetic supervisor beta decision";
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            var tokens = scope.ServiceProvider.GetRequiredService<IJwtTokenService>();
            var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
            var hash = hasher.Hash("Str0ng!TestPassword");
            var alpha = new User { Username = "retire-alpha", DisplayName = "Alpha Supervisor", Role = Role.Supervisor,
                PasswordHash = hash.Hash, PasswordSalt = hash.Salt, PasswordIterations = hash.Iterations,
                IsActive = true, CreatedUtc = DateTimeOffset.UtcNow };
            var betaHash = hasher.Hash("Str0ng!TestPassword");
            var beta = new User { Username = "retire-beta", DisplayName = "Beta Supervisor", Role = Role.Supervisor,
                PasswordHash = betaHash.Hash, PasswordSalt = betaHash.Salt, PasswordIterations = betaHash.Iterations,
                IsActive = true, CreatedUtc = DateTimeOffset.UtcNow };
            db.Users.AddRange(alpha, beta);
            var site = new Site { Name = "Attribution site", Client = new Client { Name = "Attribution client" } };
            var cabinet = new Cabinet { MachineId = "retire-attribution", Hostname = "synthetic-attribution", Site = site,
                Role = CabinetRole.Sync, ApprovedByUserId = alpha.Id, ApprovedUtc = DateTimeOffset.UtcNow };
            db.Cabinets.Add(cabinet);
            await db.SaveChangesAsync();
            site.SyncCabinetId = cabinet.Id;
            await db.SaveChangesAsync();
            id = cabinet.Id;
            firstActor = reverseArrival ? beta.Id : alpha.Id;
            secondActor = reverseArrival ? alpha.Id : beta.Id;
            firstClient.DefaultRequestHeaders.Authorization = new("Bearer", tokens.Issue(reverseArrival ? beta : alpha).AccessToken);
            secondClient.DefaultRequestHeaders.Authorization = new("Bearer", tokens.Issue(reverseArrival ? alpha : beta).AccessToken);
        }
        string winningReason = reverseArrival ? secondReason : firstReason;
        string losingReason = reverseArrival ? firstReason : secondReason;
        string winningName = reverseArrival ? "retire-beta" : "retire-alpha";
        gate.Armed = true;
        Task<HttpResponseMessage> first = Task.Run(() => firstClient.PostJsonAsync($"/api/cabinets/{id}/retire", new { Reason = winningReason }));
        Task<HttpResponseMessage>? second = null;
        try
        {
            await gate.Reached.Task.WaitAsync(TimeSpan.FromSeconds(15));
            second = Task.Run(() => secondClient.PostJsonAsync($"/api/cabinets/{id}/retire", new { Reason = losingReason }));
            await arrival.Reached.Task.WaitAsync(TimeSpan.FromSeconds(15));
            Assert.False(second.IsCompleted);
        }
        finally { gate.Release.TrySetResult(); }
        using var firstResponse = await first.WaitAsync(TimeSpan.FromSeconds(30));
        using var secondResponse = await second!.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(HttpStatusCode.NoContent, firstResponse.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, secondResponse.StatusCode);
        using var verifyScope = factory.Services.CreateScope();
        var verify = verifyScope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var saved = await verify.Cabinets.Include(c => c.Site).SingleAsync(c => c.Id == id);
        Assert.False(saved.IsActive);
        Assert.Null(saved.Site!.SyncCabinetId);
        var audit = Assert.Single(await verify.AuditEntries.Where(a => a.CabinetId == id && a.Event == AuditEvent.RetireCabinet).ToListAsync());
        Assert.Equal(AuditResult.Success, audit.Result);
        Assert.Equal(ActorType.User, audit.ActorType);
        Assert.Equal(firstActor.ToString(), audit.ActorId);
        Assert.NotEqual(secondActor.ToString(), audit.ActorId);
        Assert.Equal(winningName, audit.ActorDisplayName);
        Assert.Equal(winningReason, audit.Reason);
        Assert.NotEqual(losingReason, audit.Reason);
    }

    private sealed class PauseAfterRetirementAudit : SaveChangesInterceptor
    {
        public bool Armed { get; set; }
        public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            if (Armed && eventData.Context!.ChangeTracker.Entries<AuditEntry>().Any(e => e.Entity.Event == AuditEvent.RetireCabinet))
            {
                Armed = false;
                Reached.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
            }
            return result;
        }
    }

    private sealed class RetirementTransactionArrival(PauseAfterRetirementAudit gate) : DbTransactionInterceptor
    {
        public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override ValueTask<InterceptionResult<DbTransaction>> TransactionStartingAsync(DbConnection connection,
            TransactionStartingEventData eventData, InterceptionResult<DbTransaction> result, CancellationToken cancellationToken = default)
        {
            if (gate.Reached.Task.IsCompleted) Reached.TrySetResult();
            return ValueTask.FromResult(result);
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
