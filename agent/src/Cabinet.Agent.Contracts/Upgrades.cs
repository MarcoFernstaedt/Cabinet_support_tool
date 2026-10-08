using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// The signed upgrade channel (docs/spec/07-upgrade-channel.md): the release files, the keys the agent
// checks them with, the updater's journal, and what the agent tells the server.

/// <summary>Which step of an upgrade failed, in the order they run.</summary>
public enum UpgradeCheck { Download, ManifestSignature, Manifest, PackageHash, Version, Authenticode, Install, CheckIn }

public sealed record UpgradeManifest
{
    public required string Product { get; init; }
    public required string Version { get; init; }
    public required string MinimumVersion { get; init; }
    public required string Sha256 { get; init; }
    public required long SizeBytes { get; init; }
    public required DateTimeOffset ReleasedAt { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Notes { get; init; }
}

public sealed record UpgradeSignature
{
    public required string KeyId { get; init; }
    public required string Algorithm { get; init; }
    public required string Signature { get; init; }
}

public sealed record UpgradeKey
{
    public required string KeyId { get; init; }
    public required string Name { get; init; }
    public required string PublicKey { get; init; }
}

public sealed record UpgradePublisher
{
    public required string CommonName { get; init; }
    public required string Organization { get; init; }
    public required string Root { get; init; }
    public required string RootFile { get; init; }
}

/// <summary>The release keys and the agent's own code-signing publisher. Compiled in; only a signed agent upgrade changes it.</summary>
public sealed record UpgradeKeys
{
    public required int Version { get; init; }
    public required IReadOnlyList<UpgradeKey> Keys { get; init; }
    public required IReadOnlyList<UpgradePublisher> Publishers { get; init; }
}

public enum UpgradePhase { Verified, Stopping, BackingUp, Installing, Waiting, Succeeded, RolledBack, Failed }

public sealed record UpgradeJournal
{
    public required Guid UpgradeId { get; init; }
    public required string Version { get; init; }
    public required string FromVersion { get; init; }
    public required UpgradePhase Phase { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public DateTimeOffset? CheckInBy { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public DateTimeOffset? FinishedAt { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public UpgradeCheck? Check { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Message { get; init; }

    [JsonIgnore] public bool Final => Phase is UpgradePhase.Succeeded or UpgradePhase.RolledBack or UpgradePhase.Failed;
}

public sealed record CheckIn
{
    public required string Version { get; init; }
    public required DateTimeOffset At { get; init; }
}

public sealed record UpgradeOffer
{
    public required string Version { get; init; }
}

public sealed record UpdateResponse
{
    public required string Version { get; init; }
    public required string Manifest { get; init; }
    public required UpgradeSignature Signature { get; init; }
}

public enum UpgradeOutcome { Succeeded, Refused, RolledBack, Failed }

public sealed record UpgradeStatus
{
    public required string Version { get; init; }
    public required string FromVersion { get; init; }
    public required UpgradeOutcome Outcome { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public UpgradeCheck? Check { get; init; }
    public required string Message { get; init; }
}
