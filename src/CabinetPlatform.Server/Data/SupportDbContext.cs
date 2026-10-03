using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;

namespace CabinetPlatform.Server.Data;

/// <summary>
/// Thrown when something tries to rewrite history. Audit rows are evidence;
/// the only legal operation on them is insert.
/// </summary>
public sealed class AuditImmutabilityException : InvalidOperationException
{
    /// <summary>Creates the exception.</summary>
    /// <param name="message">What was attempted.</param>
    public AuditImmutabilityException(string message) : base(message) { }
}

/// <summary>
/// The server's whole database.
/// </summary>
/// <remarks>
/// <para>
/// Every query against this context is LINQ, with no provider-specific SQL
/// anywhere. SQLite is fine for local development; PostgreSQL is required
/// before any multi-site deployment, and the difference is a connection string
/// and a package, not a rewrite.
/// </para>
/// <para>
/// The telemetry tables are indexed on <c>(CabinetId, TimestampUtc)</c> with
/// time-based partitioning in mind: on PostgreSQL, <c>Heartbeats</c> and
/// <c>SmartReadings</c> are the two that will be range-partitioned by month,
/// and the index order is the one a partitioned scan wants.
/// </para>
/// </remarks>
public class SupportDbContext : DbContext
{
    /// <summary>Creates the context.</summary>
    /// <param name="options">Provider and connection configuration.</param>
    public SupportDbContext(DbContextOptions<SupportDbContext> options) : base(options) { }

    /// <summary>Support users.</summary>
    public DbSet<User> Users => Set<User>();

    /// <summary>Refresh tokens, the one piece of session state the server keeps.</summary>
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    /// <summary>Client organisations.</summary>
    public DbSet<Client> Clients => Set<Client>();

    /// <summary>Client sites.</summary>
    public DbSet<Site> Sites => Set<Site>();

    /// <summary>Approved cabinets.</summary>
    public DbSet<Cabinet> Cabinets => Set<Cabinet>();

    /// <summary>Exact staff/cabinet read authority for the isolated demo surface.</summary>
    public DbSet<CabinetReadGrant> CabinetReadGrants => Set<CabinetReadGrant>();

    /// <summary>Agents waiting for a Supervisor decision.</summary>
    public DbSet<PendingRegistration> PendingRegistrations => Set<PendingRegistration>();

    /// <summary>Non-credential successor identity reservations.</summary>
    public DbSet<SuccessorReservation> SuccessorReservations => Set<SuccessorReservation>();

    /// <summary>The five-minute tier, stored as typed columns and no payload.</summary>
    public DbSet<Heartbeat> Heartbeats => Set<Heartbeat>();

    /// <summary>Inventory change history, one row per distinct inventory.</summary>
    public DbSet<InventoryVersion> InventoryVersions => Set<InventoryVersion>();

    /// <summary>The failure-prediction time series.</summary>
    public DbSet<SmartReading> SmartReadings => Set<SmartReading>();

    /// <summary>Cabinet-to-cabinet reachability, most recent per pair.</summary>
    public DbSet<CabinetLinkProbe> CabinetLinkProbes => Set<CabinetLinkProbe>();

    public DbSet<ConnectivityEvidence> ConnectivityEvidence => Set<ConnectivityEvidence>();
    public DbSet<ConnectivityAlert> ConnectivityAlerts => Set<ConnectivityAlert>();

    public DbSet<ConnectivityConfiguration> ConnectivityConfigurations => Set<ConnectivityConfiguration>();

    /// <summary>The append-only audit trail.</summary>
    public DbSet<AuditEntry> AuditEntries => Set<AuditEntry>();

    /// <summary>Individual action requests.</summary>
    public DbSet<ActionRequest> ActionRequests => Set<ActionRequest>();

    /// <summary>Multi-cabinet batches.</summary>
    public DbSet<BatchActionRequest> BatchActionRequests => Set<BatchActionRequest>();

    /// <summary>The frozen target list of each batch.</summary>
    public DbSet<BatchActionTarget> BatchActionTargets => Set<BatchActionTarget>();

    /// <summary>Named event log filters, shared across every support user.</summary>
    public DbSet<EventLogView> EventLogViews => Set<EventLogView>();

    /// <summary>Each rep's recently opened cabinets.</summary>
    public DbSet<RecentCabinetView> RecentCabinetViews => Set<RecentCabinetView>();

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder b)
    {
        base.OnModelCreating(b);

        b.Entity<User>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Username).IsRequired().HasMaxLength(64);
            e.HasIndex(x => x.Username).IsUnique();
            e.Property(x => x.DisplayName).IsRequired().HasMaxLength(128);
            e.Property(x => x.PasswordHash).IsRequired();
            e.Property(x => x.PasswordSalt).IsRequired();
            e.Property(x => x.Role).HasConversion<int>();
            e.HasIndex(x => x.IsActive);

            // Guards the permission fields: two Supervisors changing the same
            // account at once is a conflict to report, never a silent overwrite.
            e.Property(x => x.RowVersion).IsConcurrencyToken();
        });

        b.Entity<RefreshToken>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.User)
                .WithMany(x => x.RefreshTokens)
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.TokenHash).IsRequired();
            e.Property(x => x.RevokedReason).HasMaxLength(256);
            e.Property(x => x.ConsumedUtc).IsConcurrencyToken();
            e.Property(x => x.RevokedUtc).IsConcurrencyToken();

            // The refresh path looks a token up by its hash and nothing else.
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.ChainId);
            e.HasIndex(x => new { x.UserId, x.ExpiresUtc });
        });

        b.Entity<Client>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired().HasMaxLength(255);
            e.HasIndex(x => x.Name).IsUnique();
        });

        b.Entity<Site>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired().HasMaxLength(255);
            e.HasOne(x => x.Client)
                .WithMany(x => x.Sites)
                .HasForeignKey(x => x.ClientId)
                .OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => new { x.ClientId, x.Name }).IsUnique();

            // One nullable column, so "a site has at most one sync cabinet" is a
            // property of the schema rather than a rule a service remembers.
            e.HasOne(x => x.SyncCabinet)
                .WithMany()
                .HasForeignKey(x => x.SyncCabinetId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<Cabinet>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.MachineId).IsRequired().HasMaxLength(128);
            // The agent-facing hot path resolves a cabinet by MachineId on every
            // single check-in, so this index is not optional.
            e.HasIndex(x => x.MachineId).IsUnique();
            e.Property(x => x.Hostname).IsRequired().HasMaxLength(255);
            e.Property(x => x.DepartmentName).HasMaxLength(255);
            e.Property(x => x.FriendlyName).HasMaxLength(120);
            e.Property(x => x.Model).HasMaxLength(128);
            e.Property(x => x.SerialNumber).HasMaxLength(128);
            e.Property(x => x.AgentVersion).HasMaxLength(64);
            e.Property(x => x.TimeZoneId).HasMaxLength(128);
            e.Property(x => x.LastKnownIpAddress).HasMaxLength(64);
            e.Property(x => x.Role).HasConversion<int>();
            e.Property(x => x.RowVersion).IsConcurrencyToken();

            e.HasOne(x => x.Site)
                .WithMany(x => x.Cabinets)
                .HasForeignKey(x => x.SiteId)
                .OnDelete(DeleteBehavior.Restrict);

            e.HasIndex(x => x.LastCheckInUtc);
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.IsActive);
            e.HasIndex(x => x.Role);

            // Search indexes. A rep types one term and it is matched against
            // every identifying column at once, so each of them has to be able
            // to narrow on its own: hostname and serial number are what a rep
            // reads off the cabinet, and department is how larger clients
            // distinguish four cabinets in one building.
            e.HasIndex(x => x.Hostname).HasDatabaseName("IX_Cabinets_Hostname");
            e.HasIndex(x => x.SerialNumber).HasDatabaseName("IX_Cabinets_SerialNumber");
            e.HasIndex(x => x.DepartmentName).HasDatabaseName("IX_Cabinets_DepartmentName");

            // Fleet aggregates read these two straight off the row rather than
            // opening seven thousand inventory documents.
            e.HasIndex(x => x.PendingSecurityUpdateCount);
            e.HasIndex(x => x.AutoStartServicesStoppedCount);
        });

        b.Entity<CabinetReadGrant>(e =>
        {
            e.HasKey(x => new { x.UserId, x.CabinetId });
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Cabinet).WithMany().HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => x.CabinetId);
        });

        b.Entity<EventLogView>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.DisplayName).IsRequired().HasMaxLength(128);

            // Unique, because views are shared by every rep and two with the
            // same name would be indistinguishable in the picker.
            e.HasIndex(x => x.DisplayName).IsUnique();
            e.Property(x => x.Description).HasMaxLength(1000);
            e.Property(x => x.LogNamesJson).IsRequired();
            e.Property(x => x.SourcesJson).IsRequired();
            e.Property(x => x.EventIdsJson).IsRequired();
            e.Property(x => x.MinimumLevel).HasConversion<int>();
            e.Property(x => x.RowVersion).IsConcurrencyToken();

            e.HasIndex(x => x.IsRetired);
        });

        b.Entity<RecentCabinetView>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.Cabinet)
                .WithMany()
                .HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);

            // One row per rep and cabinet, updated in place. A history of every
            // view would be a second audit trail with none of the guarantees of
            // the real one.
            e.HasIndex(x => new { x.UserId, x.CabinetId }).IsUnique();
            e.HasIndex(x => new { x.UserId, x.LastViewedUtc })
                .IsDescending(false, true)
                .HasDatabaseName("IX_RecentCabinetViews_UserId_LastViewedUtc_Desc");
        });

        b.Entity<PendingRegistration>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.MachineId).IsRequired().HasMaxLength(128);
            // One live registration record per machine: a chatty agent updates
            // its row rather than filling the approval queue with duplicates.
            e.HasIndex(x => x.MachineId).IsUnique();
            e.Property(x => x.Hostname).IsRequired().HasMaxLength(255);
            e.Property(x => x.OsVersion).HasMaxLength(255);
            e.Property(x => x.AgentVersion).HasMaxLength(64);
            e.Property(x => x.Status).HasConversion<int>();
            e.HasIndex(x => x.Status);
        });

        b.Entity<SuccessorReservation>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.SuccessorMachineId).IsRequired().HasMaxLength(128);
            e.HasIndex(x => x.SuccessorMachineId).IsUnique();
            e.HasIndex(x => x.PredecessorCabinetId).IsUnique();
            e.HasOne(x => x.PredecessorCabinet).WithMany()
                .HasForeignKey(x => x.PredecessorCabinetId).OnDelete(DeleteBehavior.Restrict);
        });

        b.Entity<Heartbeat>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.Cabinet)
                .WithMany()
                .HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.WorstDiskHealth).HasConversion<int>();
            e.Property(x => x.AgentVersion).HasMaxLength(64);
            e.Property(x => x.SectionErrorsJson).IsRequired();

            // "Latest heartbeat for this cabinet" is the hottest query in the
            // system — the fleet grid runs it once per cabinet per refresh.
            e.HasIndex(x => new { x.CabinetId, x.ReceivedUtc })
                .IsDescending(false, true)
                .HasDatabaseName("IX_Heartbeats_CabinetId_ReceivedUtc_Desc");

            // Backs both the idempotency check and the retention sweeps.
            e.HasIndex(x => new { x.CabinetId, x.CollectedAtUtc })
                .IsUnique()
                .HasDatabaseName("IX_Heartbeats_CabinetId_CollectedAtUtc");

            // The sweep boundary. On PostgreSQL this table is range-partitioned
            // by month and this is the partition key's leading column.
            e.HasIndex(x => x.ReceivedUtc);
        });

        b.Entity<InventoryVersion>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.Cabinet)
                .WithMany()
                .HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.ContentHash).IsRequired().HasMaxLength(64);
            e.Property(x => x.PayloadJson).IsRequired();
            e.Property(x => x.SectionErrorsJson).IsRequired();

            e.HasIndex(x => new { x.CabinetId, x.LastObservedUtc })
                .IsDescending(false, true)
                .HasDatabaseName("IX_InventoryVersions_CabinetId_LastObservedUtc_Desc");

            // Not unique: an inventory may legitimately change and change back,
            // and the history should show both transitions.
            e.HasIndex(x => new { x.CabinetId, x.ContentHash });
        });

        b.Entity<SmartReading>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.Cabinet)
                .WithMany()
                .HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.DriveSerial).IsRequired().HasMaxLength(128);
            e.Property(x => x.DriveModel).HasMaxLength(128);
            e.Property(x => x.Health).HasConversion<int>();
            e.Property(x => x.Source).HasConversion<int>();

            // Trending one drive over time is the query this table exists for.
            e.HasIndex(x => new { x.CabinetId, x.DriveSerial, x.TimestampUtc })
                .IsDescending(false, false, true)
                .HasDatabaseName("IX_SmartReadings_Cabinet_Drive_Timestamp_Desc");

            e.HasIndex(x => new { x.CabinetId, x.TimestampUtc })
                .IsDescending(false, true)
                .HasDatabaseName("IX_SmartReadings_CabinetId_TimestampUtc_Desc");

            e.HasIndex(x => x.TimestampUtc);
        });

        b.Entity<ConnectivityAlert>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.SourceCabinet).WithMany().HasForeignKey(x => x.SourceCabinetId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => new { x.SourceCabinetId, x.EvidenceId }).IsUnique();
            e.HasIndex(x => new { x.SourceCabinetId, x.ReceivedUtc });
            e.Property(x => x.Status).IsRequired().HasMaxLength(20);
            e.Property(x => x.Note).HasMaxLength(1000);
        });

        b.Entity<ConnectivityEvidence>(e =>
        {
            e.HasKey(x => new { x.SourceCabinetId, x.Id });
            e.Property(x => x.SummaryJson).IsRequired().HasMaxLength(4096);
            e.HasIndex(x => new { x.SourceCabinetId, x.TargetCabinetId, x.ObservedUtc });
            e.HasOne<Cabinet>().WithMany().HasForeignKey(x => x.SourceCabinetId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ConnectivityConfiguration>(e =>
        {
            e.HasKey(x => x.SourceCabinetId);
            e.Property(x => x.TargetsJson).IsRequired().HasMaxLength(2048);
            e.HasOne<Cabinet>().WithMany().HasForeignKey(x => x.SourceCabinetId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<CabinetLinkProbe>(e =>
        {
            e.HasKey(x => x.Id);
            // One row per ordered pair: the question is "can this cabinet reach
            // that one now", not "what has it ever reported".
            e.HasIndex(x => new { x.SourceCabinetId, x.TargetCabinetId }).IsUnique();
        });

        b.Entity<AuditEntry>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.ActorType).HasConversion<int>().IsRequired();
            e.Property(x => x.ActorId).HasMaxLength(128);
            e.Property(x => x.ActorDisplayName).HasMaxLength(128);
            e.Property(x => x.CabinetHostname).HasMaxLength(255);
            e.Property(x => x.TargetCabinetHostname).HasMaxLength(255);
            e.Property(x => x.Reason).HasMaxLength(2000);
            e.Property(x => x.TicketReference).HasMaxLength(64);
            e.Property(x => x.CorrelationId).HasMaxLength(64);
            e.Property(x => x.RemoteIpAddress).HasMaxLength(64);

            // EventKind is required and indexed: "show me everything this
            // server caused" must not degrade into a table scan.
            e.Property(x => x.EventKind).HasConversion<int>().IsRequired();
            e.Property(x => x.Event).HasConversion<int>().IsRequired();
            e.Property(x => x.Action).HasConversion<int>();
            e.Property(x => x.Result).HasConversion<int>().IsRequired();

            e.HasIndex(x => x.EventKind);
            e.HasIndex(x => x.Event);
            e.HasIndex(x => x.CabinetId);
            e.HasIndex(x => x.ActorId);
            e.HasIndex(x => x.TimestampUtc);
            e.HasIndex(x => new { x.CabinetId, x.TimestampUtc })
                .HasDatabaseName("IX_AuditEntries_CabinetId_TimestampUtc");
            e.HasIndex(x => x.BatchId);
            e.HasIndex(x => x.Result);
        });

        b.Entity<ActionRequest>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.Cabinet)
                .WithMany()
                .HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.Action).HasConversion<int>();
            e.Property(x => x.Status).HasConversion<int>();
            e.Property(x => x.ResultStatus).HasConversion<int>();
            e.Property(x => x.ParametersJson).IsRequired();
            e.Property(x => x.Reason).IsRequired().HasMaxLength(1000);
            e.Property(x => x.TicketReference).HasMaxLength(64);
            e.Property(x => x.OverrideReason).HasMaxLength(1000);
            e.Property(x => x.ResultOutput).HasMaxLength(8000);
            e.Property(x => x.RowVersion).IsConcurrencyToken();

            // Reserved for hardware actuation and never written in this build.
            // Mapped so that the column exists with the rest of the record,
            // rather than arriving in a migration alongside the feature that
            // first needs it.
            e.Property(x => x.OnSiteConfirmedByUserId);
            e.Property(x => x.OnSiteConfirmedUtc);

            // The agent poll: approved, undispatched, unexpired, this cabinet.
            e.HasIndex(x => new { x.CabinetId, x.Status })
                .HasDatabaseName("IX_ActionRequests_CabinetId_Status");
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.RequestedByUserId);
            e.HasIndex(x => x.ExpiresUtc);
            e.HasIndex(x => x.BatchId);
        });

        b.Entity<BatchActionRequest>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Action).HasConversion<int>();
            e.Property(x => x.Status).HasConversion<int>();
            e.Property(x => x.ParametersJson).IsRequired();
            e.Property(x => x.Reason).IsRequired().HasMaxLength(1000);
            e.Property(x => x.TicketReference).HasMaxLength(64);
            e.Property(x => x.DenialReason).HasMaxLength(1000);
            e.Property(x => x.RowVersion).IsConcurrencyToken();

            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.RequestedByUserId);
        });

        b.Entity<BatchActionTarget>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.Batch)
                .WithMany(x => x.Targets)
                .HasForeignKey(x => x.BatchId)
                .OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Cabinet)
                .WithMany()
                .HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.SkippedReason).HasMaxLength(500);

            // The frozen list. One row per cabinet per batch, so a batch cannot
            // name the same cabinet twice.
            e.HasIndex(x => new { x.BatchId, x.CabinetId }).IsUnique();
        });
    }

    /// <inheritdoc />
    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        GuardAuditImmutability();
        StampConcurrencyTokens();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    /// <inheritdoc />
    public override Task<int> SaveChangesAsync(
        bool acceptAllChangesOnSuccess,
        CancellationToken cancellationToken = default)
    {
        GuardAuditImmutability();
        StampConcurrencyTokens();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }

    /// <summary>
    /// Gives every inserted or updated row a fresh concurrency token.
    /// </summary>
    /// <remarks>
    /// Databases differ on how they generate row versions — SQL Server has
    /// <c>rowversion</c>, PostgreSQL has <c>xmin</c>, SQLite has neither — and
    /// this system has to run on two of them unchanged. Stamping the token here
    /// makes optimistic concurrency behave identically on every provider: EF
    /// still writes the value the row was loaded with into the WHERE clause, so
    /// a concurrent update still loses the race and still raises
    /// <see cref="DbUpdateConcurrencyException"/>, which is the whole point.
    /// </remarks>
    private void StampConcurrencyTokens()
    {
        foreach (EntityEntry entry in ChangeTracker.Entries())
        {
            if (entry.State is not (EntityState.Added or EntityState.Modified))
            {
                continue;
            }

            PropertyEntry? token = entry.Properties
                .FirstOrDefault(p => p.Metadata.Name == "RowVersion" && p.Metadata.IsConcurrencyToken);

            if (token is not null)
            {
                token.CurrentValue = Guid.NewGuid().ToByteArray();
            }
        }
    }

    /// <summary>
    /// Last line of defence for the audit trail. There is no repository method
    /// that updates or deletes an <see cref="AuditEntry"/>, but a future caller
    /// could always reach the DbSet directly — so the context itself refuses.
    /// </summary>
    private void GuardAuditImmutability()
    {
        foreach (EntityEntry<AuditEntry> entry in ChangeTracker.Entries<AuditEntry>())
        {
            switch (entry.State)
            {
                case EntityState.Modified:
                    throw new AuditImmutabilityException(
                        $"Audit entry {entry.Entity.Id} was modified. Audit records are append-only.");
                case EntityState.Deleted:
                    throw new AuditImmutabilityException(
                        $"Audit entry {entry.Entity.Id} was deleted. Audit records are append-only.");
            }
        }
    }
}
