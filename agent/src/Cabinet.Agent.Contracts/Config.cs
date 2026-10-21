using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Configuration snapshots (docs/spec/15-baselines-and-config.md): config.snapshot and the change-only upload.
// Shapes from contracts/schemas/operations/config.snapshot.schema.json and envelopes/config-upload.schema.json.

/// <summary>The parts of a cabinet's configuration that are collected. The wire names are the lower-case enum names.</summary>
public enum ConfigCategory { Network, Services, Drivers, Updates, Firewall, Time, Devices, Applications, Hosts, Tasks, System }

/// <summary>One thing in a category, by a stable key, with a flat map of values: text, whole numbers, true or false, nothing, or a list of texts.</summary>
public sealed record ConfigItem
{
    public required string Key { get; init; }
    public required IReadOnlyDictionary<string, object?> Values { get; init; }
}

public sealed record ConfigSnapshotCategory
{
    public required ConfigCategory Category { get; init; }
    /// <summary>SHA-256 of the canonical JSON of the items sorted by key (see ConfigCanonical), 64 lower-case hex digits.</summary>
    public required string Hash { get; init; }
    public required bool Truncated { get; init; }
    public required IReadOnlyList<ConfigItem> Items { get; init; }
}

public sealed record ConfigSnapshotParams
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<ConfigCategory>? Categories { get; init; }
}

public sealed record ConfigSnapshotOutput
{
    public required DateTimeOffset TakenAt { get; init; }
    public required IReadOnlyList<ConfigSnapshotCategory> Categories { get; init; }
}

public sealed record ConfigUploadSnapshot
{
    public required DateTimeOffset ObservedAt { get; init; }
    public required ConfigCategory Category { get; init; }
    public required string Hash { get; init; }
    public required bool Truncated { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? GapBefore { get; init; }
    public required IReadOnlyList<ConfigItem> Items { get; init; }
}

public sealed record ConfigUpload
{
    public required IReadOnlyList<ConfigUploadSnapshot> Snapshots { get; init; }
}
