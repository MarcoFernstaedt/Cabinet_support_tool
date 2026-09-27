using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Data;

/// <summary>
/// Creates the first Supervisor on an empty database, and nothing else.
///
/// The seeded account exists only to let a human log in once and build the
/// real ones. It is flagged MustChangePassword, so the configured value buys
/// exactly one login — and that value is supplied per deployment, never
/// committed and never defaulted to something guessable.
/// </summary>
public sealed class DatabaseSeeder
{
    private readonly SupportDbContext _db;
    private readonly IPasswordHasher _hasher;
    private readonly IAuditService _audit;
    private readonly SeedOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<DatabaseSeeder> _logger;

    public DatabaseSeeder(
        SupportDbContext db,
        IPasswordHasher hasher,
        IAuditService audit,
        IOptions<SeedOptions> options,
        TimeProvider timeProvider,
        ILogger<DatabaseSeeder> logger)
    {
        _db = db;
        _hasher = hasher;
        _audit = audit;
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    /// <summary>Seeds whatever an empty database is missing.</summary>
    /// <param name="ct">Cancels the operation.</param>
    public async Task SeedAsync(CancellationToken ct = default)
    {
        // Independent of the Supervisor seed on purpose. A deployment that is
        // already running should still pick up a default view added in a later
        // release, and views are shared rather than per-account so there is no
        // reason to tie them to whether anybody has signed in yet.
        await SeedEventLogViewsAsync(ct);

        // Only ever on a genuinely empty user table. A deployment that already
        // has accounts must not gain a back door on restart.
        if (await _db.Users.AnyAsync(ct))
        {
            return;
        }

        ValidateBootstrapConfiguration();

        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;
        PasswordHashResult hashed = _hasher.Hash(_options.SupervisorInitialPassword!);

        var supervisor = new User
        {
            Username = _options.SupervisorUsername.Trim(),
            DisplayName = _options.SupervisorDisplayName.Trim(),
            Role = Role.Supervisor,
            PasswordHash = hashed.Hash,
            PasswordSalt = hashed.Salt,
            PasswordIterations = hashed.Iterations,
            IsActive = true,
            MustChangePassword = true,
            HasElevatedSql = false,
            CreatedUtc = nowUtc,
            // Null: nobody created this account, the server did.
            CreatedByUserId = null
        };

        _db.Users.Add(supervisor);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.SeedSupervisor,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.System,
            ActorDisplayName = nameof(DatabaseSeeder),
            Reason = "Seeded the first Supervisor on an empty database.",
            // The username is an identifier. The password is not logged here,
            // is not in the audit details, and is not in the log line below.
            Details = new { supervisor.Id, supervisor.Username, MustChangePassword = true }
        });

        await _db.SaveChangesAsync(ct);

        _logger.LogWarning(
            "Seeded initial Supervisor '{Username}'. This account must change its password at " +
            "first login.", supervisor.Username);
    }

    /// <summary>Checks bootstrap inputs without changing schema or data.</summary>
    public void ValidateBootstrapConfiguration()
    {
        if (_options.SupervisorUsername.Trim().Any(c => c > 127))
            throw new InvalidOperationException("The configured Supervisor username must use ASCII characters.");

        if (string.IsNullOrWhiteSpace(_options.SupervisorInitialPassword))
        {
            // Refuse rather than invent one. A server that silently seeds a
            // default credential is worse than a server that will not start.
            throw new InvalidOperationException(
                $"{SeedOptions.SectionName}:SupervisorInitialPassword must be configured to " +
                "seed the first Supervisor on an empty database.");
        }

        string? complaint = _hasher.ValidateComplexity(_options.SupervisorInitialPassword);
        if (complaint is not null)
            throw new InvalidOperationException(
                $"The configured initial Supervisor password does not meet policy: {complaint}");
    }

    /// <summary>
    /// Adds the default event log views a support desk needs on day one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Support should not have to invent these before they can use the screen.
    /// Each one is a question that comes up on real calls: what is the CUBEX
    /// application complaining about, did Windows Update fail, is the disk
    /// retrying reads, and did a service die rather than being stopped.
    /// </para>
    /// <para>
    /// Seeded by name and never overwritten. A Supervisor who has narrowed one
    /// of these after a year of calls knows more about it than this method
    /// does, and a restart must not undo that. A view that has been retired
    /// stays retired for the same reason.
    /// </para>
    /// </remarks>
    private async Task SeedEventLogViewsAsync(CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        var defaults = new[]
        {
            new SeededView(
                "CUBEX application errors",
                "Errors and warnings from the CUBEX and ZIMBIS application stack.",
                new[] { EventLogName.Application },
                new[]
                {
                    "MashuraCabinetService",
                    "MashuraDispenseController",
                    "MashuraSyncService",
                    "CubexClient",
                    "ZimbisClient",
                    "Application Error",
                    ".NET Runtime",
                },
                Array.Empty<int>(),
                EventLogLevel.Warning,
                DefaultWindowHours: 24,
                MaximumEntries: 500),

            new SeededView(
                "Windows Update client",
                "What the update client did, and why an install failed when one did.",
                new[] { EventLogName.System, EventLogName.Application },
                new[] { "Microsoft-Windows-WindowsUpdateClient", "Microsoft-Windows-WUSA" },
                // The four ids that carry an install outcome. Without them this
                // view is every routine detection message the client emits,
                // which is the firehose it exists to replace.
                new[] { 19, 20, 21, 43 },
                EventLogLevel.Information,
                DefaultWindowHours: 168,
                MaximumEntries: 300),

            new SeededView(
                "Disk and storage",
                "The disk and storage stack retrying, timing out, or reporting bad blocks.",
                new[] { EventLogName.System },
                new[]
                {
                    "disk",
                    "Disk",
                    "Ntfs",
                    "storahci",
                    "stornvme",
                    "volmgr",
                    "Microsoft-Windows-Ntfs",
                    "Microsoft-Windows-StorageSpaces-Driver",
                },
                // 7, 11, 51, 52, 98 and 153 are the ones that actually precede a
                // failing drive: bad block, controller error, paging error,
                // predictive failure, corruption and retried request.
                new[] { 7, 11, 51, 52, 98, 153 },
                EventLogLevel.Warning,
                DefaultWindowHours: 168,
                MaximumEntries: 500),

            new SeededView(
                "Service control manager",
                "Services that failed to start, terminated unexpectedly, or changed start type.",
                new[] { EventLogName.System },
                new[] { "Service Control Manager" },
                new[] { 7000, 7001, 7009, 7011, 7022, 7023, 7024, 7031, 7034, 7040 },
                EventLogLevel.Warning,
                DefaultWindowHours: 72,
                MaximumEntries: 300),
        };

        var added = 0;

        foreach (SeededView seed in defaults)
        {
            if (await _db.EventLogViews.AnyAsync(v => v.DisplayName == seed.DisplayName, ct))
            {
                continue;
            }

            _db.EventLogViews.Add(new EventLogView
            {
                DisplayName = seed.DisplayName,
                Description = seed.Description,
                LogNamesJson = JsonSerializer.Serialize(seed.LogNames, ContractJson.Default),
                SourcesJson = JsonSerializer.Serialize(seed.Sources, ContractJson.Default),
                EventIdsJson = JsonSerializer.Serialize(seed.EventIds, ContractJson.Default),
                MinimumLevel = seed.MinimumLevel,
                DefaultWindowHours = seed.DefaultWindowHours,
                MaximumEntries = seed.MaximumEntries,
                IsSeeded = true,
                CreatedUtc = nowUtc,
                // Null: nobody defined this view, the platform did.
                CreatedByUserId = null,
            });

            added++;
        }

        if (added == 0)
        {
            return;
        }

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.CreateEventLogView,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.System,
            ActorDisplayName = nameof(DatabaseSeeder),
            Reason = "Seeded the platform's default event log views.",
            Details = new { SeededCount = added },
        });

        await _db.SaveChangesAsync(ct);

        _logger.LogInformation("Seeded {Count} default event log view(s).", added);
    }

    private sealed record SeededView(
        string DisplayName,
        string Description,
        EventLogName[] LogNames,
        string[] Sources,
        int[] EventIds,
        EventLogLevel MinimumLevel,
        int DefaultWindowHours,
        int MaximumEntries);
}
