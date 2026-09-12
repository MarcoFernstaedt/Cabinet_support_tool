using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

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

    /// <summary>
    /// Maps every <see cref="DateTimeOffset"/> to sortable UTC text.
    /// </summary>
    /// <remarks>
    /// <para>
    /// SQLite has no date type, so its EF provider refuses to translate
    /// <c>&lt;</c>, <c>&lt;=</c>, <c>&gt;</c> and <c>&gt;=</c> on a
    /// <see cref="DateTimeOffset"/> — a "could not be translated" exception at
    /// runtime, not a compile error. Every range query in this server is over a
    /// timestamp, so without this every one of them throws.
    /// </para>
    /// <para>
    /// The stored form is fixed-width UTC text, so a string comparison in
    /// SQLite orders identically to a chronological one. That is the whole
    /// reason for the fixed width: with a trimmed fractional part, two values a
    /// tick apart can sort the wrong way round.
    /// </para>
    /// <para>
    /// This is provider configuration, not a provider-specific query: the
    /// queries stay LINQ and are byte-for-byte the same against PostgreSQL,
    /// which has a real <c>timestamptz</c> and needs none of this.
    /// </para>
    /// </remarks>
    /// <param name="builder">The convention builder.</param>
    protected override void ConfigureConventions(ModelConfigurationBuilder builder)
    {
        base.ConfigureConventions(builder);

        builder.Properties<DateTimeOffset>().HaveConversion<SortableUtcTextConverter>();
    }

    private static DbContextOptions<SupportDbContext> Rebuild(DbContextOptions<SqliteSupportDbContext> options) =>
        ProviderContextOptions.Rebase(options);

    /// <summary>
    /// Round-trips a <see cref="DateTimeOffset"/> through fixed-width UTC text.
    /// </summary>
    /// <remarks>
    /// Normalising to UTC on the way in is safe because every timestamp in this
    /// system is UTC by rule; a cabinet's local time is derived for display from
    /// its own zone, never stored. Anything that did arrive with an offset is
    /// converted rather than truncated, so no instant is altered.
    /// </remarks>
    private sealed class SortableUtcTextConverter : ValueConverter<DateTimeOffset, string>
    {
        private const string Format = "yyyy-MM-dd HH:mm:ss.fffffff+00:00";

        public SortableUtcTextConverter()
            : base(
                value => value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture),
                text => DateTimeOffset.Parse(
                    text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal).ToUniversalTime())
        {
        }
    }
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
