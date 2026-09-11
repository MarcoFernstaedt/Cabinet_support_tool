using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Server.Tests;

/// <summary>Helpers shared by the integration tests.</summary>
public static class TestClient
{
    /// <summary>The same wire convention the server and agent use.</summary>
    public static readonly JsonSerializerOptions Json = Contracts.Common.ContractJson.CreateOptions();

    /// <summary>
    /// Creates a user directly in the database and returns a client carrying a
    /// real token for them. The token is minted by the server's own token
    /// service, so the tests exercise the same claims the login path produces.
    /// </summary>
    public static async Task<(HttpClient Client, User User)> CreateUserClientAsync(
        SupportApiFactory factory,
        Role role,
        string username,
        bool hasElevatedSql = false,
        bool mustChangePassword = false,
        bool isActive = true)
    {
        using IServiceScope scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        var tokens = scope.ServiceProvider.GetRequiredService<IJwtTokenService>();

        PasswordHashResult hashed = hasher.Hash("Str0ng!TestPassword");

        var user = new User
        {
            Username = username,
            DisplayName = username,
            Role = role,
            PasswordHash = hashed.Hash,
            PasswordSalt = hashed.Salt,
            PasswordIterations = hashed.Iterations,
            IsActive = isActive,
            HasElevatedSql = hasElevatedSql,
            MustChangePassword = mustChangePassword,
            CreatedUtc = DateTime.UtcNow
        };

        db.Users.Add(user);
        await db.SaveChangesAsync();

        IssuedToken token = tokens.Issue(user);

        HttpClient client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.AccessToken);

        return (client, user);
    }

    /// <summary>A client presenting a valid agent key for the given machine.</summary>
    public static HttpClient CreateAgentClient(
        SupportApiFactory factory, string machineId, string? agentKey = null)
    {
        HttpClient client = factory.CreateClient();
        client.DefaultRequestHeaders.Add(
            "X-Mashura-Agent-Key", agentKey ?? SupportApiFactory.AgentSharedSecret);
        client.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", machineId);
        return client;
    }

    public static async Task<Cabinet> CreateApprovedCabinetAsync(
        SupportApiFactory factory,
        string machineId,
        Guid approvedBy,
        bool isActive = true)
    {
        return await factory.WithDbAsync(async db =>
        {
            var cabinet = new Cabinet
            {
                MachineId = machineId,
                Hostname = $"host-{machineId}",
                ClientName = "Test Veterinary Group",
                SiteName = "Main Clinic",
                DepartmentName = "Pharmacy",
                ApprovedUtc = DateTime.UtcNow,
                ApprovedByUserId = approvedBy,
                IsActive = isActive
            };

            db.Cabinets.Add(cabinet);
            await db.SaveChangesAsync();
            return cabinet;
        });
    }

    public static Task<int> CountAuditAsync(
        SupportApiFactory factory, string action, AuditResult result) =>
        factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .CountAsync(a => a.Action == action && a.Result == result));

    public static Task<List<Domain.AuditEntry>> AuditEntriesAsync(
        SupportApiFactory factory, string action) =>
        factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Action == action)
            .ToListAsync());

    public static Task<HttpResponseMessage> PostJsonAsync<T>(
        this HttpClient client, string url, T body) =>
        client.PostAsJsonAsync(url, body, Json);

    public static Task<HttpResponseMessage> PatchJsonAsync<T>(
        this HttpClient client, string url, T body) =>
        client.PatchAsJsonAsync(url, body, Json);

    public static async Task<T?> ReadAsync<T>(this HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<T>(Json);
}
