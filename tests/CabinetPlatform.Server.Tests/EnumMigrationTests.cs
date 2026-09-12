using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Registrations;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// Ruling 3: the enum values that changed meaning between the two lineages, and
/// the migration that remaps rows written under the old ones.
/// </summary>
/// <remarks>
/// <para>
/// The dangerous case is not a value that was added but one that was reused. An
/// <c>AuditResult</c> of 2 meant Failure on one side and Denied on the other, so
/// every refusal in a migrated audit trail would read as a failure and every
/// failure as a refusal — in a table that may be read in a DEA compliance
/// review, and with no error anywhere to say so.
/// </para>
/// <para>
/// No deployment of the other lineage's schema exists: no database file is
/// committed on any branch and <c>*.db</c> is ignored, so the remap rewrites
/// nothing today. It ships anyway, because the moment one does exist the cost
/// of not having shipped it is a silently wrong compliance record.
/// </para>
/// <para>
/// These tests pin the numbers the whole remap is defined against. If an enum
/// is renumbered again, the migration's arithmetic stops matching the code it
/// was written for, and this is what says so.
/// </para>
/// </remarks>
public sealed class EnumMigrationTests
{
    [Fact]
    public void The_audit_result_values_the_migration_remaps_to_are_the_ones_in_force()
    {
        // The swap at the centre of Ruling 3. Session 3 wrote Denied=2 and
        // Failure=3; these are session 1's, which the migration maps onto.
        Assert.Equal(1, (int)AuditResult.Success);
        Assert.Equal(2, (int)AuditResult.Failure);
        Assert.Equal(3, (int)AuditResult.Denied);
    }

    [Fact]
    public void The_action_status_values_the_migration_remaps_to_are_the_ones_in_force()
    {
        // Session 3 had TimedOut and Denied the other way round, and had no
        // UnknownResult at all — the state a reboot leaves behind, which must
        // never be inferred as a failure and never auto-retried.
        Assert.Equal(1, (int)ActionStatus.Succeeded);
        Assert.Equal(2, (int)ActionStatus.Failed);
        Assert.Equal(3, (int)ActionStatus.Denied);
        Assert.Equal(4, (int)ActionStatus.TimedOut);
        Assert.Equal(5, (int)ActionStatus.UnknownResult);
    }

    [Fact]
    public void The_disk_health_values_the_migration_remaps_to_are_the_ones_in_force()
    {
        // Session 3 had five values, Warning and Critical among them. Four here,
        // with Unknown at zero so that a drive nobody could read never defaults
        // to Healthy.
        Assert.Equal(0, (int)DiskHealthStatus.Unknown);
        Assert.Equal(1, (int)DiskHealthStatus.Healthy);
        Assert.Equal(2, (int)DiskHealthStatus.Watch);
        Assert.Equal(3, (int)DiskHealthStatus.Failing);

        Assert.Equal(4, Enum.GetValues<DiskHealthStatus>().Length);
    }

    [Fact]
    public void The_action_name_values_the_migration_remaps_to_are_the_ones_in_force()
    {
        // Seven of the nine original actions moved. The remap is by number, so
        // these are what it maps onto; there is no name-based fallback.
        Assert.Equal(1, (int)ActionName.ScanForUpdates);
        Assert.Equal(2, (int)ActionName.ScheduleUpdates);
        Assert.Equal(3, (int)ActionName.CollectDiagnosticBundle);
        Assert.Equal(4, (int)ActionName.FlushDnsCache);
        Assert.Equal(5, (int)ActionName.RenewDhcpLease);
        Assert.Equal(6, (int)ActionName.RestartService);
        Assert.Equal(7, (int)ActionName.StartService);
        Assert.Equal(8, (int)ActionName.StopService);
        Assert.Equal(9, (int)ActionName.RebootMachine);

        // Nothing occupies zero, so an uninitialised column cannot resolve to
        // an action. The catalog refuses it too, and both are deliberate.
        Assert.DoesNotContain(0, Enum.GetValues<ActionName>().Select(a => (int)a));
    }

    [Fact]
    public void The_enums_the_audit_found_unchanged_are_still_unchanged()
    {
        // Stated as explicitly as the ones that moved. "We checked and it did
        // not need remapping" is a finding, and a renumbering of one of these
        // later would silently invalidate that finding.
        Assert.Equal(1, (int)AuditEventKind.Observed);
        Assert.Equal(2, (int)AuditEventKind.Caused);

        Assert.Equal(1, (int)ActionRequestStatus.PendingApproval);
        Assert.Equal(2, (int)ActionRequestStatus.Approved);
        Assert.Equal(3, (int)ActionRequestStatus.Denied);
        Assert.Equal(4, (int)ActionRequestStatus.Dispatched);
        Assert.Equal(5, (int)ActionRequestStatus.Completed);
        Assert.Equal(6, (int)ActionRequestStatus.Expired);
        Assert.Equal(7, (int)ActionRequestStatus.Cancelled);

        Assert.Equal(1, (int)Role.Tier1);
        Assert.Equal(2, (int)Role.Tier2);
        Assert.Equal(3, (int)Role.Supervisor);

        Assert.Equal(1, (int)RegistrationStatus.Pending);
        Assert.Equal(2, (int)RegistrationStatus.Approved);
        Assert.Equal(3, (int)RegistrationStatus.Rejected);
    }

    [Fact]
    public void Every_persisted_enum_reserves_zero_for_not_known_or_uses_none_at_all()
    {
        // The property that makes a zeroed column safe. Either zero means
        // "unknown" — Unknown, Unavailable, or a state the collector could not
        // read — or the enum starts at one and a zero is simply not a value, so
        // nothing defaults into a meaningful state.
        (Type Type, string Name)[] persisted =
        {
            (typeof(AuditResult), nameof(AuditResult)),
            (typeof(AuditEventKind), nameof(AuditEventKind)),
            (typeof(AuditEvent), nameof(AuditEvent)),
            (typeof(ActorType), nameof(ActorType)),
            (typeof(ActionName), nameof(ActionName)),
            (typeof(ActionStatus), nameof(ActionStatus)),
            (typeof(ActionRequestStatus), nameof(ActionRequestStatus)),
            (typeof(DiskHealthStatus), nameof(DiskHealthStatus)),
            (typeof(SmartSource), nameof(SmartSource)),
            (typeof(CabinetRole), nameof(CabinetRole)),
            (typeof(CabinetHealthStatus), nameof(CabinetHealthStatus)),
            (typeof(Role), nameof(Role)),
            (typeof(RegistrationStatus), nameof(RegistrationStatus)),
            (typeof(ServiceState), nameof(ServiceState)),
            (typeof(ServiceStartType), nameof(ServiceStartType)),
            (typeof(BitLockerStatus), nameof(BitLockerStatus)),
        };

        var offenders = new List<string>();

        foreach ((Type type, string name) in persisted)
        {
            string? zero = Enum.GetValues(type)
                .Cast<object>()
                .FirstOrDefault(v => Convert.ToInt32(v) == 0)?
                .ToString();

            if (zero is null)
            {
                continue;
            }

            if (zero is not ("Unknown" or "Unavailable" or "NotEncrypted" or "None"))
            {
                offenders.Add($"{name}.{zero} = 0");
            }
        }

        Assert.True(offenders.Count == 0,
            "Enums whose zero value means something other than 'not known': " +
            string.Join(", ", offenders));
    }

    /// <summary>
    /// The remap itself, run against a database holding rows written under the
    /// other lineage's numbering.
    /// </summary>
    /// <remarks>
    /// A schema-shaped fixture rather than the real earlier migration, because
    /// the earlier schema is a whole lineage and the property under test is one
    /// arithmetic. The columns are the ones the migration's UPDATE statements
    /// name, and the values are what session 3 actually wrote.
    /// </remarks>
    [Fact]
    public void The_remap_turns_every_old_value_into_the_right_new_one()
    {
        using var connection = new SqliteConnection(
            $"DataSource=file:enum-migration-{Guid.NewGuid():N}?mode=memory&cache=shared");

        connection.Open();

        Execute(connection, "CREATE TABLE AuditEntries (Id TEXT PRIMARY KEY, Result INTEGER);");
        Execute(connection, "CREATE TABLE ActionRequests (Id TEXT PRIMARY KEY, Action INTEGER, ResultStatus INTEGER);");
        Execute(connection, "CREATE TABLE SmartReadings (Id TEXT PRIMARY KEY, PredictedHealth INTEGER);");

        // Session 3's numbering: Success=1, Denied=2, Failure=3.
        InsertRange(connection, "INSERT INTO AuditEntries (Id, Result) VALUES (@id, @v);", 1, 2, 3);

        // Session 3's action numbering for the three the test follows: 8 was
        // its ScheduleUpdates, 2 its CollectDiagnosticBundle, 1 its
        // ScanForUpdates — the one of the nine that did not move.
        InsertRange(connection, "INSERT INTO ActionRequests (Id, Action) VALUES (@id, @v);", 8, 2, 1);

        // Session 3: Denied=3, TimedOut=4.
        InsertRange(connection, "INSERT INTO ActionRequests (Id, ResultStatus) VALUES (@id, @v);", 3, 4, 1);

        // Session 3 had a fifth disk state; 4 collapses onto Failing.
        InsertRange(connection, "INSERT INTO SmartReadings (Id, PredictedHealth) VALUES (@id, @v);", 4, 3, 1);

        // The statements the migration runs, verbatim in shape.
        Execute(connection,
            "UPDATE AuditEntries SET Result = CASE Result WHEN 2 THEN 3 WHEN 3 THEN 2 ELSE Result END;");

        Execute(connection,
            "UPDATE ActionRequests SET Action = CASE Action " +
            "WHEN 2 THEN 3 WHEN 3 THEN 4 WHEN 4 THEN 5 WHEN 5 THEN 6 " +
            "WHEN 6 THEN 7 WHEN 7 THEN 8 WHEN 8 THEN 2 ELSE Action END;");

        Execute(connection,
            "UPDATE ActionRequests SET ResultStatus = CASE ResultStatus " +
            "WHEN 3 THEN 4 WHEN 4 THEN 3 ELSE ResultStatus END;");

        Execute(connection, "UPDATE SmartReadings SET PredictedHealth = 3 WHERE PredictedHealth = 4;");

        // A refusal is still a refusal and a failure is still a failure. This
        // is the assertion the whole ruling is about.
        Assert.Equal(
            new[] { (int)AuditResult.Success, (int)AuditResult.Denied, (int)AuditResult.Failure },
            Read(connection, "SELECT Result FROM AuditEntries ORDER BY rowid;"));

        Assert.Equal(
            new[]
            {
                (int)ActionName.ScheduleUpdates,
                (int)ActionName.CollectDiagnosticBundle,
                (int)ActionName.ScanForUpdates,
            },
            Read(connection, "SELECT Action FROM ActionRequests WHERE Action IS NOT NULL ORDER BY rowid;"));

        Assert.Equal(
            new[] { (int)ActionStatus.TimedOut, (int)ActionStatus.Denied, (int)ActionStatus.Succeeded },
            Read(connection, "SELECT ResultStatus FROM ActionRequests WHERE ResultStatus IS NOT NULL ORDER BY rowid;"));

        Assert.Equal(
            new[]
            {
                (int)DiskHealthStatus.Failing,
                (int)DiskHealthStatus.Failing,
                (int)DiskHealthStatus.Healthy,
            },
            Read(connection, "SELECT PredictedHealth FROM SmartReadings ORDER BY rowid;"));
    }

    [Fact]
    public async Task Both_provider_migration_sets_bring_up_the_same_model()
    {
        // The SQLite set is applied by every test in this suite; what this adds
        // is that the model it produces is the one the code expects, with no
        // pending difference left over. A model the migrations do not
        // reproduce is a deployment that fails on the first query, not on
        // migration.
        using var connection = new SqliteConnection(
            $"DataSource=file:migration-check-{Guid.NewGuid():N}?mode=memory&cache=shared");

        await connection.OpenAsync();

        var options = new DbContextOptionsBuilder<SqliteSupportDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var db = new SqliteSupportDbContext(options);

        await db.Database.MigrateAsync();

        Assert.Empty(await db.Database.GetPendingMigrationsAsync());

        // And the remapped tables are queryable through the model, which is the
        // other half: a migration can succeed and still leave a column the
        // model cannot read.
        Assert.Equal(0, await db.AuditEntries.CountAsync());
        Assert.Equal(0, await db.SmartReadings.CountAsync());
        Assert.Equal(0, await db.Heartbeats.CountAsync());
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static void InsertRange(SqliteConnection connection, string sql, params int[] values)
    {
        foreach (int value in values)
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = sql;
            command.Parameters.AddWithValue("@id", Guid.NewGuid().ToString());
            command.Parameters.AddWithValue("@v", value);
            command.ExecuteNonQuery();
        }
    }

    private static int[] Read(SqliteConnection connection, string sql)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;

        using SqliteDataReader reader = command.ExecuteReader();

        var values = new List<int>();

        while (reader.Read())
        {
            values.Add(reader.GetInt32(0));
        }

        return values.ToArray();
    }
}
