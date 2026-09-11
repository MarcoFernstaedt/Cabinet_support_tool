using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Server.Data;

/// <summary>
/// Thrown when something tries to rewrite history. Audit rows are evidence;
/// the only legal operation on them is insert.
/// </summary>
public sealed class AuditImmutabilityException : InvalidOperationException
{
    public AuditImmutabilityException(string message) : base(message) { }
}

public class SupportDbContext : DbContext
{
    public SupportDbContext(DbContextOptions<SupportDbContext> options) : base(options) { }

    public DbSet<User> Users => Set<User>();
    public DbSet<Cabinet> Cabinets => Set<Cabinet>();
    public DbSet<PendingRegistration> PendingRegistrations => Set<PendingRegistration>();
    public DbSet<CheckIn> CheckIns => Set<CheckIn>();
    public DbSet<SmartReading> SmartReadings => Set<SmartReading>();
    public DbSet<AuditEntry> AuditEntries => Set<AuditEntry>();
    public DbSet<ActionRequest> ActionRequests => Set<ActionRequest>();

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
        });

        b.Entity<Cabinet>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.MachineId).IsRequired().HasMaxLength(128);
            // The agent-facing hot path resolves a cabinet by MachineId on every
            // single check-in, so this index is not optional.
            e.HasIndex(x => x.MachineId).IsUnique();
            e.Property(x => x.Hostname).IsRequired().HasMaxLength(255);
            e.Property(x => x.ClientName).IsRequired().HasMaxLength(255);
            e.Property(x => x.SiteName).IsRequired().HasMaxLength(255);
            e.Property(x => x.DepartmentName).HasMaxLength(255);
            e.Property(x => x.Model).HasMaxLength(128);
            e.Property(x => x.SerialNumber).HasMaxLength(128);
            e.Property(x => x.AgentVersion).HasMaxLength(64);
            e.HasIndex(x => x.LastCheckInUtc);
            e.HasIndex(x => new { x.ClientName, x.SiteName });
            e.HasIndex(x => x.IsActive);
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

        b.Entity<CheckIn>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasOne(x => x.Cabinet)
                .WithMany()
                .HasForeignKey(x => x.CabinetId)
                .OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.PayloadJson).IsRequired();
            e.Property(x => x.WorstDiskHealth).HasConversion<int>();

            // "Latest check-in for this cabinet" is the hottest query in the
            // system — the fleet grid runs it once per cabinet per refresh.
            e.HasIndex(x => new { x.CabinetId, x.ReceivedUtc })
                .IsDescending(false, true)
                .HasDatabaseName("IX_CheckIns_CabinetId_ReceivedUtc_Desc");

            // Backs both the idempotency check and retention sweeps.
            e.HasIndex(x => new { x.CabinetId, x.CollectedAtUtc })
                .IsUnique()
                .HasDatabaseName("IX_CheckIns_CabinetId_CollectedAtUtc");

            e.HasIndex(x => x.ReceivedUtc);
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
            e.Property(x => x.FirmwareVersion).HasMaxLength(64);
            e.Property(x => x.DeviceId).HasMaxLength(128);
            e.Property(x => x.PredictedHealth).HasConversion<int>();

            // Trending one drive over time is the query this table exists for.
            e.HasIndex(x => new { x.CabinetId, x.DriveSerial, x.TimestampUtc })
                .HasDatabaseName("IX_SmartReadings_Cabinet_Drive_Timestamp");

            e.HasIndex(x => x.TimestampUtc);
        });

        b.Entity<AuditEntry>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.ActorType).IsRequired().HasMaxLength(32);
            e.Property(x => x.ActorId).HasMaxLength(128);
            e.Property(x => x.ActorDisplayName).HasMaxLength(128);
            e.Property(x => x.Action).IsRequired().HasMaxLength(128);
            e.Property(x => x.CabinetHostname).HasMaxLength(255);
            e.Property(x => x.Reason).HasMaxLength(2000);
            e.Property(x => x.TicketReference).HasMaxLength(64);
            e.Property(x => x.CorrelationId).HasMaxLength(64);
            e.Property(x => x.RemoteIpAddress).HasMaxLength(64);

            // EventKind is required and indexed: "show me everything this
            // server caused" must not degrade into a table scan.
            e.Property(x => x.EventKind).HasConversion<int>().IsRequired();
            e.Property(x => x.Result).HasConversion<int>().IsRequired();

            e.HasIndex(x => x.EventKind);
            e.HasIndex(x => x.CabinetId);
            e.HasIndex(x => x.ActorId);
            e.HasIndex(x => x.TimestampUtc);
            e.HasIndex(x => new { x.CabinetId, x.TimestampUtc })
                .HasDatabaseName("IX_AuditEntries_CabinetId_TimestampUtc");
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

            // The agent poll: approved, undispatched, unexpired, this cabinet.
            e.HasIndex(x => new { x.CabinetId, x.Status })
                .HasDatabaseName("IX_ActionRequests_CabinetId_Status");
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.RequestedByUserId);
            e.HasIndex(x => x.ExpiresUtc);
        });
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        GuardAuditImmutability();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(
        bool acceptAllChangesOnSuccess,
        CancellationToken cancellationToken = default)
    {
        GuardAuditImmutability();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
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
