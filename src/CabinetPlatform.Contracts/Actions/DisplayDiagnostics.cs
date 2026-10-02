using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Actions;

/// <summary>OS display modes visible to the service, not the interactive user's effective resolution.</summary>
public sealed record DisplayDiagnostics
{
    /// <summary>UTC time the service completed the observation.</summary>
    public required DateTimeOffset ObservedAtUtc { get; init; }
    /// <summary>Whether the OS mode read succeeded, was unavailable, or was denied.</summary>
    public required DisplayModeStatus ModeStatus { get; init; }
    /// <summary>At most eight indexed mode rows, without device identity.</summary>
    public required IReadOnlyList<DisplayModeObservation> Modes { get; init; }
    /// <summary>True when more than eight modes were reported by the native source.</summary>
    public required bool ModesTruncated { get; init; }
    /// <summary>Availability of interactive-user scaling, which this service does not measure.</summary>
    public required DisplaySessionStatus ScalingStatus { get; init; }
    /// <summary>Only populated with a reliable session-aware measurement; currently always null.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public int? ScalingPercent { get; init; }
    /// <summary>Availability of interactive-user Magnifier state.</summary>
    public required DisplaySessionStatus MagnifierStatus { get; init; }
    /// <summary>Availability of per-application zoom, which is not collected.</summary>
    public required DisplaySessionStatus AppZoomStatus { get; init; }
}

/// <summary>Result of an OS mode read.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DisplayModeStatus
{
    /// <summary>At least one OS mode was observed.</summary>
    Observed,
    /// <summary>No trustworthy mode was returned.</summary>
    Unavailable,
    /// <summary>Access to the mode source was denied.</summary>
    Denied
}

/// <summary>Availability of a separate interactive-session fact.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DisplaySessionStatus
{
    /// <summary>A source was attempted but could not provide the fact.</summary>
    Unavailable,
    /// <summary>A service-context read cannot establish the interactive user's fact.</summary>
    InteractiveSessionInaccessible,
    /// <summary>No source was attempted.</summary>
    NotCollected
}

/// <summary>Numerical OS mode without any monitor name, path, or identifier.</summary>
public sealed record DisplayModeObservation
{
    /// <summary>Zero-based ordinal within the bounded response, not a persistent identifier.</summary>
    public required int DisplayIndex { get; init; }
    /// <summary>Mode width in pixels.</summary>
    public required int WidthPixels { get; init; }
    /// <summary>Mode height in pixels.</summary>
    public required int HeightPixels { get; init; }
    /// <summary>Mode refresh rate when reported within a plausible range.</summary>
    public int? RefreshHz { get; init; }
}
