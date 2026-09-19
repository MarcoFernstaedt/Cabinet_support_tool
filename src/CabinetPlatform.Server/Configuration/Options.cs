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

    /// <summary>
    /// What the server tells a healthy agent to wait between heartbeats. Seven
    /// thousand cabinets at five minutes is about twenty-three samples a
    /// second, which one instance serves comfortably.
    /// </summary>
    public int CheckInIntervalSeconds { get; set; } = 300;

    /// <summary>
    /// What the server tells an agent to wait between full check-ins —
    /// inventory and SMART. Six hours by default: often enough that a change is
    /// noticed the same working day, rare enough that the inventory history
    /// stays a history rather than a log.
    /// </summary>
    public int FullCheckInIntervalSeconds { get; set; } = 21_600;

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

    /// <summary>
    /// Default window for the fleet view's stale count, in hours.
    /// </summary>
    /// <remarks>
    /// Deliberately much wider than <see cref="OfflineAfterMinutes"/>, because
    /// the two answer different questions. Offline is a verdict about one
    /// cabinet. Stale asks whether the telemetry itself is arriving: a fleet
    /// with three hundred stale cabinets has an agent or a network problem, not
    /// three hundred broken cabinets, and the two numbers diverging is the
    /// signal worth acting on.
    /// </remarks>
    public int StaleAfterHours { get; set; } = 24;

    /// <summary>Widest stale window a caller may ask the fleet view for, in hours.</summary>
    public int MaxStaleAfterHours { get; set; } = 8_760;

    /// <summary>Rejects a sample timestamped implausibly far in the future.</summary>
    public int MaxClockSkewMinutes { get; set; } = 10;
}

public sealed class ActionOptions
{
    /// <summary>Legacy value retained for config compatibility; cannot widen a monitoring release.</summary>
    public string ExecutionMode { get; set; } = "DiagnosticOnly";

    /// <summary>Maintenance is available only in the explicit historical test build.</summary>
    public bool MaintenanceEnabled => CabinetPlatform.Contracts.Actions.MonitoringBoundary.LegacyMaintenanceTestBuild &&
        string.Equals(ExecutionMode, "Maintenance", StringComparison.Ordinal);

    public bool DemoEnabled => CabinetPlatform.Contracts.Actions.MonitoringBoundary.LegacyMaintenanceTestBuild &&
        string.Equals(ExecutionMode, "Demo", StringComparison.Ordinal);

    /// <summary>Compiled capability ceiling; never infer safety from a non-disruptive flag.</summary>
    public bool Permits(CabinetPlatform.Contracts.Actions.ActionName action) =>
        Enum.IsDefined(action) && (MaintenanceEnabled ||
            (DemoEnabled && action == CabinetPlatform.Contracts.Actions.ActionName.KillProcess) ||
            CabinetPlatform.Contracts.Actions.MonitoringBoundary.IsObservation(action));

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

    /// <summary>
    /// Maintenance window start, in whole hours, <em>in the cabinet's own time
    /// zone</em>. A window of 2 to 6 means 02:00 to 06:00 where the cabinet is,
    /// not where the server is and not where the rep is. The fleet spans
    /// thirteen countries; evaluating this against the server's clock would run
    /// reboots in the middle of somebody's working day.
    /// </summary>
    public int MaintenanceWindowStartHourLocal { get; set; } = 2;

    /// <summary>
    /// Maintenance window end, in whole hours, in the cabinet's own time zone.
    /// A window whose end is before its start crosses midnight and is handled
    /// as two intervals.
    /// </summary>
    public int MaintenanceWindowEndHourLocal { get; set; } = 6;

    /// <summary>
    /// How far ahead of now a scheduled update install may be set. Checked in
    /// the cabinet's zone, so a daylight-saving transition between scheduling
    /// and execution does not move the install.
    /// </summary>
    public int MaxUpdateScheduleDays { get; set; } = 30;

    /// <summary>Hard ceiling on the number of cabinets one batch may name.</summary>
    public int MaximumBatchSize { get; set; } = 500;
}

public sealed class RetentionOptions
{
    public const string SectionName = "Retention";

    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Full-resolution heartbeats are kept this long, then rolled into hourly
    /// aggregates. Two million samples a day is not a volume to keep at full
    /// resolution for its own sake, and nobody reads a five-minute sample from
    /// three weeks ago.
    /// </summary>
    public int HeartbeatFullResolutionDays { get; set; } = 7;

    /// <summary>
    /// Hourly heartbeat aggregates are kept this long, then deleted. Ninety
    /// days is enough to see a cabinet's trend across a quarter.
    /// </summary>
    public int HeartbeatAggregateRetentionDays { get; set; } = 90;

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

    /// <summary>
    /// Inventory versions are a change history and are never aged out on their
    /// own: a cabinet that has not changed in two years holds one row. This
    /// caps the number of distinct versions kept per cabinet, oldest first, so
    /// a cabinet flapping between two configurations cannot grow without bound.
    /// </summary>
    public int MaxInventoryVersionsPerCabinet { get; set; } = 200;

    /// <summary>How often the retention sweep runs.</summary>
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
