using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
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

    public async Task SeedAsync(CancellationToken ct = default)
    {
        // Only ever on a genuinely empty user table. A deployment that already
        // has accounts must not gain a back door on restart.
        if (await _db.Users.AnyAsync(ct))
        {
            return;
        }

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
        {
            throw new InvalidOperationException(
                $"The configured initial Supervisor password does not meet policy: {complaint}");
        }

        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;
        PasswordHashResult hashed = _hasher.Hash(_options.SupervisorInitialPassword);

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
}
