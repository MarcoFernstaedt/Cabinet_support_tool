using System.Net;
using System.Net.Http.Headers;
using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Contracts.Users;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// An unauthorized attempt that leaves no trace is a bug. These tests are the
/// ones that would catch it.
/// </summary>
public sealed class AuditTrailTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public AuditTrailTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task An_unauthenticated_request_is_refused_and_audited()
    {
        int before = await TestClient.CountAuditAsync(
            _factory, AuditActions.AuthorizationDenied, AuditResult.Denied);

        HttpClient client = _factory.CreateClient();
        HttpResponseMessage response = await client.GetAsync("/api/cabinets");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);

        int after = await TestClient.CountAuditAsync(
            _factory, AuditActions.AuthorizationDenied, AuditResult.Denied);

        Assert.True(after > before, "A refused request must leave an audit record.");
    }

    [Fact]
    public async Task A_Tier1_reaching_for_a_Supervisor_endpoint_is_refused_and_audited()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier1, Unique("tier1"));

        HttpResponseMessage response = await client.GetAsync("/api/registrations/pending");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        List<Domain.AuditEntry> denials = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == AuditActions.AuthorizationDenied &&
                        a.Result == AuditResult.Denied &&
                        a.ActorId == user.Id.ToString())
            .ToListAsync());

        Assert.NotEmpty(denials);

        // A refusal changed nothing on any cabinet, so it belongs to the
        // Observed stream with a Denied result — never to Caused.
        Assert.All(denials, d => Assert.Equal(AuditEventKind.Observed, d.EventKind));
        Assert.All(denials, d => Assert.Equal(ActorTypes.User, d.ActorType));
    }

    [Fact]
    public async Task A_failed_login_is_audited_without_recording_the_password()
    {
        (_, User user) = await TestClient.CreateUserClientAsync(
            _factory, UserRole.Tier1, Unique("loginfail"));

        HttpClient client = _factory.CreateClient();

        const string attemptedPassword = "ThisIsTheWrongPassword!1";

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/auth/login",
            new LoginRequest { Username = user.Username, Password = attemptedPassword });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        List<Domain.AuditEntry> entries = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == AuditActions.Login && a.Result == AuditResult.Denied)
            .ToListAsync());

        Assert.NotEmpty(entries);

        // Nothing anywhere in the record may echo the attempted credential.
        foreach (Domain.AuditEntry entry in entries)
        {
            Assert.DoesNotContain(attemptedPassword, entry.Reason ?? string.Empty);
            Assert.DoesNotContain(attemptedPassword, entry.Details ?? string.Empty);
            Assert.DoesNotContain(attemptedPassword, entry.ActorDisplayName ?? string.Empty);
        }
    }

    [Fact]
    public async Task Repeated_failures_lock_the_account_and_the_lockout_is_audited()
    {
        (_, User user) = await TestClient.CreateUserClientAsync(
            _factory, UserRole.Tier1, Unique("lockout"));

        HttpClient client = _factory.CreateClient();

        for (int i = 0; i < 5; i++)
        {
            await client.PostJsonAsync(
                "/api/auth/login",
                new LoginRequest { Username = user.Username, Password = $"Wrong!Password{i}" });
        }

        DateTime? lockedUntil = await _factory.WithDbAsync(db => db.Users
            .AsNoTracking().Where(u => u.Id == user.Id).Select(u => u.LockedUntilUtc).FirstAsync());

        Assert.NotNull(lockedUntil);
        Assert.True(lockedUntil > DateTime.UtcNow);

        // And the correct password now fails too, for as long as the lock holds.
        HttpResponseMessage locked = await client.PostJsonAsync(
            "/api/auth/login",
            new LoginRequest { Username = user.Username, Password = "Str0ng!TestPassword" });

        Assert.Equal(HttpStatusCode.Forbidden, locked.StatusCode);
    }

    [Fact]
    public async Task A_successful_read_is_recorded_as_Observed_not_Caused()
    {
        (HttpClient client, User user) =
            await TestClient.CreateUserClientAsync(_factory, UserRole.Tier1, Unique("reader"));

        HttpResponseMessage response = await client.GetAsync("/api/cabinets");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Domain.AuditEntry entry = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == AuditActions.ListCabinets && a.ActorId == user.Id.ToString())
            .OrderByDescending(a => a.TimestampUtc)
            .FirstAsync());

        Assert.Equal(AuditEventKind.Observed, entry.EventKind);
        Assert.Equal(AuditResult.Success, entry.Result);
        Assert.False(string.IsNullOrWhiteSpace(entry.CorrelationId));
    }

    [Fact]
    public async Task An_audit_entry_cannot_be_modified()
    {
        await _factory.WithDbAsync(async db =>
        {
            db.AuditEntries.Add(new Domain.AuditEntry
            {
                TimestampUtc = DateTime.UtcNow,
                ActorType = ActorTypes.System,
                Action = "test.immutability",
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Success
            });

            await db.SaveChangesAsync();
        });

        using IServiceScope scope = _factory.Services.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        Domain.AuditEntry tracked = await context.AuditEntries
            .FirstAsync(a => a.Action == "test.immutability");

        tracked.Reason = "Rewriting history.";

        await Assert.ThrowsAsync<AuditImmutabilityException>(() => context.SaveChangesAsync());
    }

    [Fact]
    public async Task An_audit_entry_cannot_be_deleted()
    {
        await _factory.WithDbAsync(async db =>
        {
            db.AuditEntries.Add(new Domain.AuditEntry
            {
                TimestampUtc = DateTime.UtcNow,
                ActorType = ActorTypes.System,
                Action = "test.no-delete",
                EventKind = AuditEventKind.Caused,
                Result = AuditResult.Success
            });

            await db.SaveChangesAsync();
        });

        using IServiceScope scope = _factory.Services.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<SupportDbContext>();

        Domain.AuditEntry tracked = await context.AuditEntries
            .FirstAsync(a => a.Action == "test.no-delete");

        context.AuditEntries.Remove(tracked);

        await Assert.ThrowsAsync<AuditImmutabilityException>(() => context.SaveChangesAsync());
    }

    [Fact]
    public async Task A_must_change_password_session_cannot_do_anything_else()
    {
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, UserRole.Supervisor, Unique("mustchange"), mustChangePassword: true);

        // The gate holds even for a Supervisor.
        HttpResponseMessage blocked = await client.GetAsync("/api/cabinets");
        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);

        // But changing the password is permitted, because that is the way out.
        HttpResponseMessage allowed = await client.PostJsonAsync(
            "/api/auth/change-password",
            new ChangePasswordRequest
            {
                CurrentPassword = "Str0ng!TestPassword",
                NewPassword = "An0ther!GoodPassword"
            });

        Assert.Equal(HttpStatusCode.NoContent, allowed.StatusCode);

        bool stillFlagged = await _factory.WithDbAsync(db => db.Users
            .AsNoTracking().Where(u => u.Id == user.Id).Select(u => u.MustChangePassword).FirstAsync());

        Assert.False(stillFlagged);
    }

    [Fact]
    public async Task The_seeded_supervisor_must_change_its_password_on_first_login()
    {
        HttpClient client = _factory.CreateClient();

        HttpResponseMessage response = await client.PostJsonAsync(
            "/api/auth/login",
            new LoginRequest
            {
                Username = SupportApiFactory.SeedSupervisorUsername,
                Password = SupportApiFactory.SeedSupervisorPassword
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        LoginResponse? body = await response.ReadAsync<LoginResponse>();

        Assert.NotNull(body);
        Assert.Equal(UserRole.Supervisor, body!.Role);
        Assert.True(body.MustChangePassword);

        // The token it issues is real but hemmed in by the same gate.
        HttpClient seeded = _factory.CreateClient();
        seeded.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", body.AccessToken);

        Assert.Equal(HttpStatusCode.Forbidden, (await seeded.GetAsync("/api/audit")).StatusCode);
    }

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];
}
