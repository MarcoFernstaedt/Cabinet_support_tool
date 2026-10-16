using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Windows inventory reads (docs/spec/04-agent-spec.md): generated from the contract schemas' shape, read-only, served by the broker.

public enum BitLockerProtection { On, Off, Unknown }

public sealed record PendingReboot
{
    public required bool Pending { get; init; }
    public required IReadOnlyList<string> Reasons { get; init; }
}

public sealed record DefenderThreat
{
    public required string Name { get; init; }
    public required DateTimeOffset? DetectedAt { get; init; }
    public required bool Active { get; init; }
}

public sealed record DefenderStatus
{
    public required bool Enabled { get; init; }
    public required bool RealTimeProtection { get; init; }
    public required long? SignatureAgeDays { get; init; }
    public required DateTimeOffset? LastQuickScan { get; init; }
    public required DateTimeOffset? LastFullScan { get; init; }
    public required IReadOnlyList<DefenderThreat> Threats { get; init; }
}

public sealed record BitLockerVolume
{
    public required string Volume { get; init; }
    public required BitLockerProtection Protection { get; init; }
    public required long? PercentEncrypted { get; init; }
}

public sealed record ActivationStatus
{
    public required bool Licensed { get; init; }
    public required string Status { get; init; }
    public required string? Edition { get; init; }
}

public sealed record CertificateExpiry
{
    public required string Store { get; init; }
    public required string Subject { get; init; }
    public required DateTimeOffset NotAfter { get; init; }
    public required long DaysLeft { get; init; }
    public required bool Expired { get; init; }
}

public sealed record SystemSecurityOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required PendingReboot PendingReboot { get; init; }
    public required DefenderStatus? Defender { get; init; }
    public required IReadOnlyList<BitLockerVolume> Bitlocker { get; init; }
    public required ActivationStatus? Activation { get; init; }
    public required IReadOnlyList<CertificateExpiry> Certificates { get; init; }
}

public sealed record InstalledProgram
{
    public required string Name { get; init; }
    public required string? Version { get; init; }
    public required string? Publisher { get; init; }
    public required string? InstalledOn { get; init; }
}

public sealed record InstalledHotfix
{
    public required string Id { get; init; }
    public required string? Description { get; init; }
    public required string? InstalledOn { get; init; }
}

public sealed record SoftwareListOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required IReadOnlyList<InstalledProgram> Programs { get; init; }
    public required IReadOnlyList<InstalledHotfix> Hotfixes { get; init; }
    public required bool Truncated { get; init; }
}

public enum TaskState { Ready, Running, Disabled, Queued, Unknown }

public sealed record StartupItem
{
    public required string Name { get; init; }
    public required string Command { get; init; }
    public required string Location { get; init; }
}

public sealed record ScheduledTaskInfo
{
    public required string Path { get; init; }
    public required string Name { get; init; }
    public required TaskState State { get; init; }
    public required DateTimeOffset? LastRun { get; init; }
    public required long? LastResult { get; init; }
    public required DateTimeOffset? NextRun { get; init; }
}

public sealed record StartupListOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required IReadOnlyList<StartupItem> Startup { get; init; }
    public required IReadOnlyList<ScheduledTaskInfo> Tasks { get; init; }
    public required bool Truncated { get; init; }
}

public enum SessionState { Active, Connected, Disconnected, Idle, Other }

public enum SessionType { Console, Remote }

public sealed record LogonSession
{
    public required long Id { get; init; }
    public required string User { get; init; }
    public required SessionState State { get; init; }
    public required SessionType Type { get; init; }
    public required DateTimeOffset? LogonTime { get; init; }
}

public sealed record SessionsListOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required IReadOnlyList<LogonSession> Sessions { get; init; }
}

public enum ShareKind { Disk, Print, Ipc, Admin, Other }

public sealed record ShareInfo
{
    public required string Name { get; init; }
    public required string? Path { get; init; }
    public required string? Description { get; init; }
    public required ShareKind Kind { get; init; }
}

public sealed record SharesListOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required IReadOnlyList<ShareInfo> Shares { get; init; }
}

public enum ReliabilityKind { AppCrash, AppHang, WindowsFailure, UpdateFailure, Other }

public sealed record ReliabilityRecord
{
    public required DateTimeOffset At { get; init; }
    public required string Source { get; init; }
    public required string? Product { get; init; }
    public required long? EventId { get; init; }
    public required ReliabilityKind Kind { get; init; }
    public required string Message { get; init; }
}

public sealed record ReliabilityListOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required IReadOnlyList<ReliabilityRecord> Records { get; init; }
    public required bool Truncated { get; init; }
}

public sealed record DiskFoldersParams
{
    public required string Path { get; init; }
}

public sealed record FolderSize
{
    public required string Name { get; init; }
    public required long SizeBytes { get; init; }
    public required long Files { get; init; }
}

public sealed record DiskFoldersOutput
{
    public required string Path { get; init; }
    public required IReadOnlyList<FolderSize> Folders { get; init; }
    public required long TotalBytes { get; init; }
    public required bool Partial { get; init; }
    public required long ElapsedMs { get; init; }
}

public sealed record DnsCacheEntry
{
    public required string Name { get; init; }
    public required string Type { get; init; }
    public required string Data { get; init; }
    public required long TtlSeconds { get; init; }
}

public sealed record DnsCacheOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required IReadOnlyList<DnsCacheEntry> Entries { get; init; }
    public required bool Truncated { get; init; }
}

public sealed record UsbSuspendSettings
{
    public required bool? PluggedIn { get; init; }
    public required bool? OnBattery { get; init; }
}

public sealed record PowerStatusOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required string Plan { get; init; }
    public required bool? FastStartup { get; init; }
    public required bool? Hibernate { get; init; }
    public required UsbSuspendSettings? UsbSelectiveSuspend { get; init; }
}
