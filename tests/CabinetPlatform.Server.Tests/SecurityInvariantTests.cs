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
        // Support needs Task Manager equivalence, so the agent does now launch
        // exactly one thing: an allow-listed application, from the install path
        // registered for it on that machine. That is a named target, not a
        // command line, and it is the only launch in the product.
        //
        // What the invariant actually guards is therefore narrower and sharper
        // than "never call Process.Start": no shell, no interpreter, no
        // command-line utility standing in for an API, and no path a request
        // could supply. Those are the properties that would let a request
        // become arbitrary execution; a single call site launching a
        // configured executable with no arguments is not one of them.
        string[] forbidden =
        {
            // Shells and interpreters. Any of these is arbitrary execution by
            // definition, whatever is passed to them.
            "cmd.exe", "powershell.exe", "pwsh.exe", "wscript", "cscript", "rundll32",

            // Command-line utilities the product has a typed API for. Each of
            // these appearing would mean somebody had reached for a process
            // where an interface existed, which is how the general mechanism
            // gets reintroduced by accident.
            "taskkill", "netsh.exe", "sc.exe", "wmic", "reg.exe", "ping.exe", "tracert",

            // The shell's own resolution: PATH lookup, file associations, URL
            // schemes. All interpretation, none of it wanted near a cabinet.
            "UseShellExecute = true", "UseShellExecute=true",

            // Arguments are the payload a launch would carry. The one launch in
            // the product passes none, and there is no property here to set.
            "ProcessStartInfo().Arguments", ".Arguments =", "ArgumentList",
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
            "Shell, interpreter or command-line-utility code: " + string.Join(", ", offenders));
    }

    /// <summary>
    /// The one place in the product that launches anything is the agent's
    /// process-control gateway, and it launches a registered path with no
    /// arguments.
    /// </summary>
    /// <remarks>
    /// Counted rather than forbidden, because the count is the property that
    /// matters. One call site can be read in a minute and reasoned about; five
    /// scattered ones are a general mechanism nobody has noticed growing. If
    /// this test fails because a second launch appeared, the question to answer
    /// is not "how do I make the test pass" but "why does a support tool need
    /// to start two different things".
    /// </remarks>
    [Fact]
    public void Only_the_agents_process_gateway_launches_anything()
    {
        var callSites = new List<string>();

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

                if (line.Contains("Process.Start(", StringComparison.Ordinal))
                {
                    callSites.Add(Path.GetFileName(file));
                }
            }
        }

        Assert.Equal(new[] { "IProcessControlGateway.cs" }, callSites.Distinct().ToArray());
        Assert.Single(callSites);
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
        // Three reserved names now exist — OpenDrawer, UnlockLock, OpenCubie —
        // so that the refusal is a real, exercised path with its own audit
        // event rather than a gap a future change could fill by accident. What
        // must not exist is anything that would carry the refusal out.
        string[] forbidden =
        {
            "ActuateLock", "EnergiseSolenoid", "DeenergiseSolenoid", "SetRelay",
            "ReleaseLock", "CloseDrawer", "UnlockDrawer", "DriveMotor",
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
    }

    /// <summary>
    /// The three reserved actuation actions are in the catalog, are flagged as
    /// reserved, and are arranged so that nothing can run them.
    /// </summary>
    /// <remarks>
    /// They exist rather than being omitted because a refusal nobody has
    /// written is a refusal nobody has tested. This asserts the shape of that
    /// refusal: the flag the service checks, and the most restrictive settings
    /// on every other field, so that even a change which accidentally routed
    /// one of them past the reserved check would find an action nobody can
    /// request.
    /// </remarks>
    [Fact]
    public void The_reserved_actuation_actions_are_arranged_so_nothing_can_run_them()
    {
        ActionName[] reserved = { ActionName.OpenDrawer, ActionName.UnlockLock, ActionName.OpenCubie };

        foreach (ActionName action in reserved)
        {
            Assert.True(ActionCatalog.TryGet(action, out ActionCatalogEntry entry));

            Assert.True(entry.IsReservedHardwareActuation,
                $"{action} must be flagged reserved; the flag is what the request service refuses on.");

            // No parameters at all, so there is nothing for a caller to supply
            // and nothing for a validator to have to reason about.
            Assert.Empty(entry.AllowedParameterKeys);

            // And every other gate at its most restrictive, as defence in depth
            // behind the flag.
            Assert.True(entry.RequiresApproval);
            Assert.True(entry.IsDisruptive);
            Assert.True(entry.MaintenanceWindowOnly);
            Assert.True(entry.BlockedIfUserLoggedOn);
            Assert.False(entry.Batchable);
        }

        // Every other action in the catalog is not reserved, so the flag has
        // not been spread by a copy-and-paste.
        Assert.Equal(
            reserved.Length,
            ActionCatalog.All.Count(e => e.IsReservedHardwareActuation));
    }

    /// <summary>
    /// The hardware interfaces are read-only: every method on them returns a
    /// reading, and none of them changes anything.
    /// </summary>
    /// <remarks>
    /// Asserted by reflection rather than by reading the file, because the
    /// point is that it stays true. A method added later that returns void, or
    /// one named to suggest a change, fails here.
    /// </remarks>
    [Fact]
    public void The_hardware_interfaces_only_read()
    {
        Type[] interfaces =
        {
            typeof(Server.Hardware.IDrawerController),
            typeof(Server.Hardware.ILockController),
            typeof(Server.Hardware.ICubieController),
            typeof(Server.Hardware.ISensorReader),
        };

        foreach (Type contract in interfaces)
        {
            foreach (System.Reflection.MethodInfo method in contract.GetMethods())
            {
                Assert.StartsWith("Read", method.Name, StringComparison.Ordinal);

                Assert.True(
                    method.ReturnType != typeof(void) && method.ReturnType != typeof(Task),
                    $"{contract.Name}.{method.Name} returns nothing, so it is not a read.");
            }
        }
    }

    /// <summary>
    /// The adapter this build ships reports every reading as unavailable.
    /// </summary>
    /// <remarks>
    /// Not an empty list, not a default value, not an exception. An empty list
    /// would read as "this cabinet has no drawers" and a default would read as
    /// "the drawer is closed" — both are assertions about a physical state
    /// nobody has observed, on a cabinet holding controlled substances.
    /// </remarks>
    [Fact]
    public async Task The_shipped_hardware_adapter_reports_everything_unavailable()
    {
        var adapter = new Server.Hardware.NullHardwareAdapter();

        Server.Hardware.HardwareReading<Server.Hardware.DrawerState> drawer =
            await adapter.ReadDrawerAsync(1, CancellationToken.None);

        Assert.False(drawer.IsAvailable);
        Assert.Null(drawer.Value);
        Assert.Equal(Server.Hardware.HardwareAvailability.NoAdapter, drawer.Unavailable);
        Assert.NotEmpty(drawer.Detail);

        Assert.False((await adapter.ReadAllDrawersAsync(CancellationToken.None)).IsAvailable);
        Assert.False((await adapter.ReadLockAsync(1, CancellationToken.None)).IsAvailable);
        Assert.False((await adapter.ReadAllLocksAsync(CancellationToken.None)).IsAvailable);
        Assert.False((await adapter.ReadCubieAsync(1, CancellationToken.None)).IsAvailable);
        Assert.False((await adapter.ReadAllCubiesAsync(CancellationToken.None)).IsAvailable);
        Assert.False((await adapter.ReadSensorAsync("temperature", CancellationToken.None)).IsAvailable);
        Assert.False((await adapter.ReadAllSensorsAsync(CancellationToken.None)).IsAvailable);
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
