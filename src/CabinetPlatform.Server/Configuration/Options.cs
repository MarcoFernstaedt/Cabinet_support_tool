namespace CabinetPlatform.Server.Configuration;

public sealed class LoginSecurityOptions
{
    public const string SectionName = "LoginSecurity";

    /// <summary>Consecutive failures before the account locks.</summary>
    public int MaxFailedAttempts { get; set; } = 5;

    /// <summary>How long a locked account stays locked.</summary>
    public int LockoutMinutes { get; set; } = 15;

    /// <summary>Per-IP login attempts permitted inside <see cref="RateLimitWindowSeconds"/>.</summary>
    public int RateLimitPermitPerWindow { get; set; } = 10;

    public int RateLimitWindowSeconds { get; set; } = 60;
}

public sealed class AgentIngestOptions
{
    public const string SectionName = "AgentIngest";

    /// <summary>What the server tells a healthy agent to wait between check-ins.</summary>
    public int CheckInIntervalSeconds { get; set; } = 300;

    /// <summary>What the server tells an unapproved agent to wait before re-registering.</summary>
    public int RegistrationRetrySeconds { get; set; } = 900;

    /// <summary>Registration attempts permitted per machine per window.</summary>
    public int RegisterPermitPerWindow { get; set; } = 5;

    public int RegisterWindowSeconds { get; set; } = 300;

    /// <summary>Check-ins permitted per cabinet per window. Generous — agents retry.</summary>
    public int CheckInPermitPerWindow { get; set; } = 20;

    public int CheckInWindowSeconds { get; set; } = 60;

    /// <summary>
    /// A cabinet with no check-in inside this window counts as Offline in the
    /// fleet view. Set comfortably above <see cref="CheckInIntervalSeconds"/>
    /// so one missed poll on a flaky clinic network is not an alert.
    /// </summary>
    public int OfflineAfterMinutes { get; set; } = 20;

    /// <summary>Rejects a sample timestamped implausibly far in the future.</summary>
    public int MaxClockSkewMinutes { get; set; } = 10;
}

public sealed class ActionOptions
{
    public const string SectionName = "Actions";

    /// <summary>
    /// How long an approved action stays collectable. An approval nobody
    /// dispatched must not fire hours later against a cabinet whose state has
    /// moved on.
    /// </summary>
    public int ApprovalExpiryMinutes { get; set; } = 30;

    /// <summary>
    /// How long an action that needs no approval stays collectable. Same
    /// reasoning, measured from the request instead of from an approval.
    /// </summary>
    public int UnapprovedActionExpiryMinutes { get; set; } = 30;

    /// <summary>How often the expiry sweep runs.</summary>
    public int ExpirySweepIntervalSeconds { get; set; } = 60;

    /// <summary>Maintenance window start, local to the server, in whole hours (UTC).</summary>
    public int MaintenanceWindowStartHourUtc { get; set; } = 2;

    public int MaintenanceWindowEndHourUtc { get; set; } = 6;
}

public sealed class RetentionOptions
{
    public const string SectionName = "Retention";

    public bool Enabled { get; set; } = true;

    /// <summary>Full-resolution check-in rows are kept this long, then deleted.</summary>
    public int CheckInRetentionDays { get; set; } = 30;

    /// <summary>
    /// Full-resolution SMART readings are kept this long before being rolled
    /// into daily aggregates. Failure prediction needs the trend, not every
    /// five-minute sample.
    /// </summary>
    public int SmartFullResolutionDays { get; set; } = 90;

    /// <summary>
    /// Aggregated SMART history is kept this long. Two years by default,
    /// because predicting a drive failure means comparing against its own
    /// history, not against a fortnight of it.
    /// </summary>
    public int SmartAggregateRetentionDays { get; set; } = 730;

    public int SweepIntervalHours { get; set; } = 6;

    /// <summary>Rows deleted per batch, to keep a sweep off the hot path.</summary>
    public int BatchSize { get; set; } = 1000;
}

public sealed class SeedOptions
{
    public const string SectionName = "Seed";

    /// <summary>Username of the bootstrap Supervisor created on an empty database.</summary>
    public string SupervisorUsername { get; set; } = "supervisor";

    public string SupervisorDisplayName { get; set; } = "Initial Supervisor";

    /// <summary>
    /// Supplied through configuration at first deployment — never committed,
    /// never defaulted. The seeded account is flagged MustChangePassword, so
    /// this value buys exactly one login and nothing else.
    /// </summary>
    public string? SupervisorInitialPassword { get; set; }
}

public sealed class QueryLimitsOptions
{
    public const string SectionName = "QueryLimits";

    /// <summary>
    /// Widest history window a single request may ask for. Unbounded history
    /// queries are refused rather than silently clamped, so the caller finds
    /// out their query was wrong.
    /// </summary>
    public int MaxHistoryRangeDays { get; set; } = 90;

    /// <summary>Window applied when a caller supplies neither bound.</summary>
    public int DefaultHistoryRangeDays { get; set; } = 7;
}
