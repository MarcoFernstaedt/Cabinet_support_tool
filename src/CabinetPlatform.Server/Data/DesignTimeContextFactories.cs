using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace CabinetPlatform.Server.Data;

/// <summary>
/// How <c>dotnet ef</c> builds each provider's context when nothing is running.
/// </summary>
/// <remarks>
/// <para>
/// Without these, the tooling tries to resolve a context out of the
/// application's own service provider — which it cannot, because the running
/// server registers exactly one provider based on configuration, and the
/// migration tooling needs to reach whichever one it was asked about. The
/// symptom is an "unable to create a DbContext" error the first time somebody
/// tries to add a migration, which is to say: the first time somebody changes
/// the model.
/// </para>
/// <para>
/// The connection strings here are used only to pick a provider's SQL
/// generator. No migration command connects to them unless it is asked to
/// update a database, and a deployment supplies its own through configuration.
/// </para>
/// </remarks>
public sealed class SqliteDesignTimeContextFactory
    : IDesignTimeDbContextFactory<SqliteSupportDbContext>
{
    /// <summary>Builds the SQLite context for the migration tooling.</summary>
    /// <param name="args">Command-line arguments, unused.</param>
    public SqliteSupportDbContext CreateDbContext(string[] args)
    {
        var builder = new DbContextOptionsBuilder<SqliteSupportDbContext>();

        builder.UseSqlite(
            Environment.GetEnvironmentVariable("ConnectionStrings__SupportDatabase")
            ?? "Data Source=cabinet-support.db");

        return new SqliteSupportDbContext(builder.Options);
    }
}

/// <inheritdoc cref="SqliteDesignTimeContextFactory" />
public sealed class PostgresDesignTimeContextFactory
    : IDesignTimeDbContextFactory<PostgresSupportDbContext>
{
    /// <summary>Builds the PostgreSQL context for the migration tooling.</summary>
    /// <param name="args">Command-line arguments, unused.</param>
    public PostgresSupportDbContext CreateDbContext(string[] args)
    {
        var builder = new DbContextOptionsBuilder<PostgresSupportDbContext>();

        builder.UseNpgsql(
            Environment.GetEnvironmentVariable("ConnectionStrings__SupportDatabase")
            ?? "Host=localhost;Database=cabinetplatform;Username=postgres;Password=postgres");

        return new PostgresSupportDbContext(builder.Options);
    }
}
