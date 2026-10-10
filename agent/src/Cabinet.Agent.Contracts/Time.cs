namespace Cabinet.Agent.Contracts;

// Time zone and clock (docs/spec/13-roadmap.md module 21): time.status, time.setZone and time.sync.

public enum TimeServiceState { Running, Stopped, NotInstalled, Unknown }

public enum TimeSyncState { Synced, NeverSynced, Unknown }

public enum TimeSyncResult { Synced, Failed, ServiceStopped }

public sealed record TimeSync
{
    public required TimeSyncState State { get; init; }
    public required string? Source { get; init; }
    public required DateTimeOffset? LastSuccessfulSync { get; init; }
}

public sealed record TimeStatusOutput
{
    public required string TimeZoneId { get; init; }
    public required string TimeZoneName { get; init; }
    public required int UtcOffsetMinutes { get; init; }
    public required bool DaylightSavingNow { get; init; }
    public required string LocalTime { get; init; }
    public required DateTimeOffset UtcTime { get; init; }
    public required TimeServiceState TimeService { get; init; }
    public required TimeSync Sync { get; init; }
    public required bool PolicyManaged { get; init; }
}

public sealed record TimeSetZoneParams
{
    public required string TimeZoneId { get; init; }
}

public sealed record TimeSetZoneOutput
{
    public required string Before { get; init; }
    public required string After { get; init; }
}

public sealed record TimeSyncOutput
{
    public required TimeSyncResult Result { get; init; }
    public required string Message { get; init; }
    public required DateTimeOffset? LastSuccessfulSyncBefore { get; init; }
    public required DateTimeOffset? LastSuccessfulSyncAfter { get; init; }
}
