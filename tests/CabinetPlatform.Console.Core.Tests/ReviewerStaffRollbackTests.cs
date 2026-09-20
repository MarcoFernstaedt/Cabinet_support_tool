using System.Data.Common;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Server.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class ReviewerStaffRollbackTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failure_after_save_before_commit_rolls_back_user_sessions_and_success_audit(bool disable)
    {
        using var host = new RollbackHost();
        var admin = await host.CreateUserAsync(Role.Supervisor, "review-admin");
        var target = await host.CreateUserAsync(Role.Tier2, "review-target");
        var (api, _) = host.CreateConsole();
        var (targetApi, _) = host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = admin.Username, Password = ConsoleTestHost.KnownPassword }, default);
        await targetApi.LoginAsync(new LoginRequest { Username = target.Username, Password = ConsoleTestHost.KnownPassword }, default);
        var prior = await host.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.Id == target.Id));
        int audits = await host.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.Event == AuditEvent.UpdateUser));
        int live = await host.WithDbAsync(db => db.RefreshTokens.CountAsync(t => t.UserId == target.Id && t.RevokedUtc == null));
        Assert.True(live > 0);
        host.Interceptor.Armed = true;
        await Assert.ThrowsAsync<ApiException>(() => api.UpdateUserAsync(target.Id, new UpdateUserRequest
        { SupportAccountsOnly = true, Role = disable ? null : Role.Tier1, IsActive = disable ? false : null }, default));
        Assert.True(host.Interceptor.Triggered);
        var after = await host.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.Id == target.Id));
        Assert.True(after.IsActive); Assert.Equal(Role.Tier2, after.Role); Assert.Equal(prior.SecurityStamp, after.SecurityStamp);
        Assert.Equal(live, await host.WithDbAsync(db => db.RefreshTokens.CountAsync(t => t.UserId == target.Id && t.RevokedUtc == null)));
        Assert.Equal(audits, await host.WithDbAsync(db => db.AuditEntries.CountAsync(a => a.Event == AuditEvent.UpdateUser)));
    }

    private sealed class RollbackHost : ConsoleTestHost
    {
        public SaveFailure Interceptor { get; } = new();
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<DbContextOptions<SqliteSupportDbContext>>();
                services.AddSingleton<DbContextOptions<SqliteSupportDbContext>>(sp =>
                    new DbContextOptionsBuilder<SqliteSupportDbContext>()
                        .UseSqlite(sp.GetRequiredService<DbConnection>().ConnectionString)
                        .AddInterceptors(Interceptor).Options);
            });
        }
    }
    private sealed class SaveFailure : SaveChangesInterceptor
    {
        public bool Armed; public bool Triggered;
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            if (Armed) { Armed = false; Triggered = true; throw new InvalidOperationException("Synthetic post-save failure before commit"); }
            return ValueTask.FromResult(result);
        }
    }
}
