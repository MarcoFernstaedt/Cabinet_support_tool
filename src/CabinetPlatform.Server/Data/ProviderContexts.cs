using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Data;

/// <summary>
/// The SQLite shape of <see cref="SupportDbContext"/>.
/// </summary>
/// <remarks>
/// <para>
/// The model is identical — every mapping lives on the base context and every
/// query in this codebase is LINQ with no provider-specific SQL. This subclass
/// exists for one reason: EF Core migrations are generated against a concrete
/// provider, and column types differ between SQLite and PostgreSQL. One
/// migration set cannot be applied to both, so there is one set per provider,
/// each scaffolded from its own context and living in its own namespace.
/// </para>
/// <para>
/// SQLite is the local development database. It is not the deployment target:
/// at seven thousand cabinets the heartbeat and SMART tables reach volumes it
/// cannot serve, and its single-writer lock is the wrong shape for twenty
/// concurrent reps besides.
/// </para>
/// </remarks>
public sealed class SqliteSupportDbContext : SupportDbContext
{
    /// <summary>Creates the context.</summary>
    /// <param name="options">Provider and connection configuration.</param>
    public SqliteSupportDbContext(DbContextOptions<SqliteSupportDbContext> options)
        : base(Rebuild(options))
    {
    }

    private static DbContextOptions<SupportDbContext> Rebuild(DbContextOptions<SqliteSupportDbContext> options) =>
        ProviderContextOptions.Rebase(options);
}

/// <summary>
/// The PostgreSQL shape of <see cref="SupportDbContext"/>, and the deployment
/// target before any multi-site rollout.
/// </summary>
/// <remarks>
/// Same model, same queries, different migration set — see
/// <see cref="SqliteSupportDbContext"/> for why the split exists at all.
/// </remarks>
public sealed class PostgresSupportDbContext : SupportDbContext
{
    /// <summary>Creates the context.</summary>
    /// <param name="options">Provider and connection configuration.</param>
    public PostgresSupportDbContext(DbContextOptions<PostgresSupportDbContext> options)
        : base(Rebuild(options))
    {
    }

    private static DbContextOptions<SupportDbContext> Rebuild(DbContextOptions<PostgresSupportDbContext> options) =>
        ProviderContextOptions.Rebase(options);
}

/// <summary>
/// Re-types a derived context's options so the base constructor accepts them.
/// </summary>
/// <remarks>
/// <see cref="DbContextOptions{TContext}"/> is invariant in its context type,
/// so a <c>DbContextOptions&lt;SqliteSupportDbContext&gt;</c> cannot be passed
/// to a constructor expecting <c>DbContextOptions&lt;SupportDbContext&gt;</c>.
/// Copying the extensions across is the supported way to keep one base context
/// and several provider-specific subclasses.
/// </remarks>
internal static class ProviderContextOptions
{
    /// <summary>Copies every configured extension onto a base-typed options object.</summary>
    /// <param name="options">The derived context's options.</param>
    public static DbContextOptions<SupportDbContext> Rebase(DbContextOptions options)
    {
        var builder = new DbContextOptionsBuilder<SupportDbContext>();

        foreach (Microsoft.EntityFrameworkCore.Infrastructure.IDbContextOptionsExtension extension
                 in options.Extensions)
        {
            ((Microsoft.EntityFrameworkCore.Infrastructure.IDbContextOptionsBuilderInfrastructure)builder)
                .AddOrUpdateExtension(extension);
        }

        return builder.Options;
    }
}
