using System.Reflection;
using System.Text.RegularExpressions;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Controllers;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The invariants this platform is not allowed to lose, held by a test rather
/// than by a review note.
/// </summary>
/// <remarks>
/// <para>
/// Each of these was verified once by reading the code. Reading it again in six
/// months is not a plan, so the ones a test can hold are held here and the ones
/// that need a running server are held by the integration tests named in each
/// comment.
/// </para>
/// <para>
/// Several of these scan source files rather than compiled metadata. That is
/// deliberate: what is being asserted is the absence of a capability, and an
/// absence is easier to prove over text than over IL. The paths are resolved
/// from the test assembly's location up to the repository root.
/// </para>
/// </remarks>
public sealed class SecurityInvariantTests
{
    /// <summary>Every C# and XAML file under src/, excluding build output.</summary>
    private static IReadOnlyList<string> SourceFiles => Source.Value;

    private static readonly Lazy<IReadOnlyList<string>> Source = new(() =>
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);

        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "src")))
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);

        return Directory
            .EnumerateFiles(Path.Combine(directory!.FullName, "src"), "*.*", SearchOption.AllDirectories)
            .Where(f => f.EndsWith(".cs", StringComparison.Ordinal) ||
                        f.EndsWith(".xaml", StringComparison.Ordinal))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                            StringComparison.Ordinal) &&
                        !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                            StringComparison.Ordinal))
            .ToList();
    });

    /// <summary>
    /// Invariant 1a: no type, field, endpoint, DTO or UI element carries a
    /// command string, a script body or SQL text.
    /// </summary>
    /// <remarks>
    /// The contract half is held by <c>ActionCatalogTests</c>, over the graph
    /// reachable from a request, a dispatch or a result. This is the other
    /// half: that the server itself never builds SQL from text.
    /// </remarks>
    [Fact]
    public void The_server_never_executes_SQL_it_composed_from_text()
    {
        // EF's raw-SQL escape hatches. Migrations use MigrationBuilder.Sql for
        // the data remap, which is a migration and is reviewed as one; nothing
        // on a request path may.
        string[] forbidden =
        {
            "ExecuteSqlRaw", "ExecuteSqlRawAsync",
            "FromSqlRaw", "SqlQueryRaw",
            "ExecuteSqlInterpolated", "FromSqlInterpolated",
        };

        var offenders = new List<string>();

        foreach (string file in SourceFiles.Where(f => !f.Contains("Migrations", StringComparison.Ordinal)))
        {
            string text = File.ReadAllText(file);

            foreach (string call in forbidden)
            {
                if (text.Contains(call, StringComparison.Ordinal))
                {
                    offenders.Add($"{Path.GetFileName(file)}: {call}");
                }
            }
        }

        Assert.True(offenders.Count == 0,
            "Raw SQL outside the migrations: " + string.Join(", ", offenders));
    }

    /// <summary>
    /// Invariant 1b: nothing in this product launches a process.
    /// </summary>
    /// <remarks>
    /// The agent's safety rests on not having a general mechanism for running
    /// programs. That is why the trace route is built from <c>Ping</c> with an
    /// increasing TTL rather than by shelling out to <c>tracert</c>: the
    /// shortcut would hand the agent exactly the capability it is designed not
    /// to have, for one action's convenience.
    /// </remarks>
    [Fact]
    public void Nothing_in_the_product_starts_a_process()
    {
        string[] forbidden =
        {
            "Process.Start", "ProcessStartInfo", "UseShellExecute", "cmd.exe", "powershell.exe",
        };

        var offenders = new List<string>();

        foreach (string file in SourceFiles)
        {
            foreach (string line in File.ReadAllLines(file))
            {
                string trimmed = line.TrimStart();

                // Comments are where this rule is explained, so they say the
                // words. Only code counts.
                if (trimmed.StartsWith("//", StringComparison.Ordinal) ||
                    trimmed.StartsWith("///", StringComparison.Ordinal) ||
                    trimmed.StartsWith("<!--", StringComparison.Ordinal))
                {
                    continue;
                }

                foreach (string call in forbidden)
                {
                    if (line.Contains(call, StringComparison.Ordinal))
                    {
                        offenders.Add($"{Path.GetFileName(file)}: {call}");
                    }
                }
            }
        }

        Assert.True(offenders.Count == 0,
            "Process-launching code: " + string.Join(", ", offenders));
    }

    /// <summary>
    /// Invariant 2: the agent resolves an executor through a dictionary keyed by
    /// <see cref="ActionName"/>, with no default and no fallback.
    /// </summary>
    /// <remarks>
    /// The server's half, asserted here: the catalog is a closed dictionary, an
    /// integer outside the enum resolves to nothing, and there is no entry at
    /// zero for an uninitialised column to land on. The agent's half is
    /// asserted in its own suite, where the registry lives.
    /// </remarks>
    [Fact]
    public void An_action_outside_the_catalogue_resolves_to_nothing()
    {
        Assert.False(ActionCatalog.TryGet((ActionName)0, out _));
        Assert.False(ActionCatalog.TryGet((ActionName)int.MaxValue, out _));
        Assert.False(ActionCatalog.TryGet((ActionName)(-1), out _));

        // Every declared action has exactly one entry, so resolution is total
        // over the enum and empty outside it.
        Assert.Equal(Enum.GetValues<ActionName>().Length, ActionCatalog.All.Count);
    }

    /// <summary>
    /// Invariant 3: a default-deny fallback policy, and an explicit policy
    /// attribute on every endpoint.
    /// </summary>
    /// <remarks>
    /// The attribute half is <c>EndpointPolicyCoverageTests</c>, which also
    /// keeps the anonymous allow-list honest in both directions. This asserts
    /// the fallback itself, which is what makes a forgotten attribute fail
    /// closed rather than open.
    /// </remarks>
    [Fact]
    public void The_fallback_authorization_policy_denies()
    {
        string program = SourceFiles.Single(f => f.EndsWith("Program.cs", StringComparison.Ordinal) &&
                                                 f.Contains("Server", StringComparison.Ordinal));

        string text = File.ReadAllText(program);

        Assert.Contains("SetFallbackPolicy", text, StringComparison.Ordinal);

        // A fallback that requires an authenticated user is not default-deny:
        // it would let any signed-in caller reach an endpoint whose attribute
        // somebody forgot. This one refuses unconditionally.
        Assert.Matches(
            new Regex(@"SetFallbackPolicy\(\s*new AuthorizationPolicyBuilder\(\)\s*\.RequireAssertion\(_ => false\)"),
            text);
    }

    /// <summary>
    /// Invariant 5: <see cref="AuditEntry"/> has no update path and no delete
    /// path, in the repository or through any controller.
    /// </summary>
    [Fact]
    public async Task An_audit_entry_can_only_ever_be_inserted()
    {
        // No controller exposes a write to the audit trail beyond reading it.
        foreach (MethodInfo action in typeof(AuditController)
                     .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
        {
            Assert.True(
                action.GetCustomAttributes().Any(a => a.GetType().Name.Contains("HttpGet", StringComparison.Ordinal)),
                $"{nameof(AuditController)}.{action.Name} is not a read.");
        }

        // And the context refuses both at the last possible moment, whatever
        // called it. Proved against a real database rather than by reading the
        // override, because an override that is never reached proves nothing.
        using var connection = new Microsoft.Data.Sqlite.SqliteConnection(
            $"DataSource=file:audit-immutability-{Guid.NewGuid():N}?mode=memory&cache=shared");

        await connection.OpenAsync();

        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var db = new SqliteSupportDbContext(options);
        await db.Database.MigrateAsync();

        var entry = new Domain.AuditEntry
        {
            TimestampUtc = DateTimeOffset.UtcNow,
            ActorType = Contracts.Audit.ActorType.System,
            Event = Contracts.Audit.AuditEvent.RetentionSweep,
            EventKind = Contracts.Audit.AuditEventKind.Observed,
            Result = Contracts.Audit.AuditResult.Success,
        };

        db.AuditEntries.Add(entry);
        await db.SaveChangesAsync();

        entry.Reason = "Rewriting history.";
        await Assert.ThrowsAsync<AuditImmutabilityException>(() => db.SaveChangesAsync());

        db.ChangeTracker.Clear();

        Domain.AuditEntry tracked = await db.AuditEntries.FirstAsync(a => a.Id == entry.Id);
        db.AuditEntries.Remove(tracked);

        await Assert.ThrowsAsync<AuditImmutabilityException>(() => db.SaveChangesAsync());
    }

    /// <summary>
    /// Invariant 8: no hardware actuation code exists anywhere.
    /// </summary>
    /// <remarks>
    /// Nothing opens a drawer, releases a lock or opens a cubie. The absence is
    /// the design, and it is worth a test because the day somebody adds one is
    /// the day it stops being reviewable by reading the diff — the change would
    /// look like any other feature.
    /// </remarks>
    [Fact]
    public void Nothing_actuates_cabinet_hardware()
    {
        string[] forbidden =
        {
            "OpenDrawer", "CloseDrawer", "UnlockDrawer", "ReleaseLock",
            "OpenCubie", "ActuateLock", "EnergiseSolenoid", "SetRelay",
        };

        var offenders = new List<string>();

        foreach (string file in SourceFiles)
        {
            foreach (string line in File.ReadAllLines(file))
            {
                string trimmed = line.TrimStart();

                if (trimmed.StartsWith("//", StringComparison.Ordinal) ||
                    trimmed.StartsWith("///", StringComparison.Ordinal) ||
                    trimmed.StartsWith("<!--", StringComparison.Ordinal))
                {
                    continue;
                }

                foreach (string call in forbidden)
                {
                    if (line.Contains(call, StringComparison.OrdinalIgnoreCase))
                    {
                        offenders.Add($"{Path.GetFileName(file)}: {call}");
                    }
                }
            }
        }

        Assert.True(offenders.Count == 0,
            "Hardware actuation code: " + string.Join(", ", offenders));

        // And the action catalog — the whole of what this product can do to a
        // cabinet — names nothing of the kind.
        Assert.DoesNotContain(
            ActionCatalog.All,
            e => forbidden.Any(f => e.Action.ToString().Contains(f, StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>
    /// No credential, hash, token or connection string is written anywhere a
    /// person or a log can read it back.
    /// </summary>
    /// <remarks>
    /// Not one of the eight named invariants, but the one they all rest on: an
    /// audit trail that echoed a password would make every other guarantee
    /// beside the point.
    /// </remarks>
    [Fact]
    public void No_audit_or_log_field_is_named_for_a_secret()
    {
        string[] forbidden =
        {
            "Password", "PasswordHash", "Secret", "Token", "ApiKey", "ConnectionString",
        };

        var offenders = new List<string>();

        foreach (PropertyInfo property in typeof(Domain.AuditEntry)
                     .GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (forbidden.Any(f => property.Name.Contains(f, StringComparison.OrdinalIgnoreCase)))
            {
                offenders.Add($"{nameof(Domain.AuditEntry)}.{property.Name}");
            }
        }

        foreach (PropertyInfo property in typeof(Contracts.Audit.AuditEntryDto)
                     .GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (forbidden.Any(f => property.Name.Contains(f, StringComparison.OrdinalIgnoreCase)))
            {
                offenders.Add($"{nameof(Contracts.Audit.AuditEntryDto)}.{property.Name}");
            }
        }

        Assert.True(offenders.Count == 0,
            "Audit fields named for a secret: " + string.Join(", ", offenders));
    }
}
