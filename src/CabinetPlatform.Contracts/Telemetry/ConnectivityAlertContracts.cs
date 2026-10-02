using System.ComponentModel.DataAnnotations;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Read-only correlation of one accepted incident, not a cause or live reachability diagnosis.</summary>
public sealed record ConnectivityCorrelationDto
{
    /// <summary>Selected alert identity.</summary>
    public Guid AlertId { get; init; }
    /// <summary>Current source site, not a stored incident-time site.</summary>
    public Guid SiteId { get; init; }
    /// <summary>Accepted source cabinet.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Accepted measured destination.</summary>
    public Guid TargetCabinetId { get; init; }
    /// <summary>Operator annotation, not measured recovery.</summary>
    public string Status { get; init; } = "Open";
    /// <summary>Exact accepted interval identity.</summary>
    public Guid EvidenceId { get; init; }
    /// <summary>Null when the exact retained accepted evidence is unavailable or inconsistent.</summary>
    public ConnectivityCorrelationIntervalDto? Interval { get; init; }
    /// <summary>Explicit reason for missing interval.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? IntervalClaim { get; init; }
    /// <summary>Current source contact and latest heartbeat provenance.</summary>
    public required ConnectivityCorrelationCabinetDto Source { get; init; }
    /// <summary>Current target contact and latest heartbeat provenance.</summary>
    public required ConnectivityCorrelationCabinetDto Target { get; init; }
    /// <summary>Current site designation, if any.</summary>
    public Guid? CurrentSyncCabinetId { get; init; }
    /// <summary>Whether the measured target is designated sync now.</summary>
    public bool TargetIsCurrentSync { get; init; }
    /// <summary>Current topology only; neither incident-time role nor proof of changed topology.</summary>
    public string TopologyClaim { get; init; } = "Current topology only; incident-time role unknown.";
    /// <summary>Application port checks are outside this measurement.</summary>
    public string ApplicationPortEvidence { get; init; } = "Not collected";
    /// <summary>Operator annotation cannot establish measured recovery.</summary>
    public string ResolutionClaim { get; init; } = "Operator resolution is not measured recovery";
}

/// <summary>Contact and latest collected heartbeat of one named cabinet.</summary>
public sealed record ConnectivityCorrelationCabinetDto
{
    /// <summary>Cabinet identity.</summary>
    public Guid CabinetId { get; init; }
    /// <summary>Any-tier server contact.</summary>
    public DateTimeOffset? LastCheckInUtc { get; init; }
    /// <summary>Latest measurement by collection time, not arrival time.</summary>
    public DateTimeOffset? LatestHeartbeatCollectedAtUtc { get; init; }
    /// <summary>Reception of that selected measurement.</summary>
    public DateTimeOffset? LatestHeartbeatReceivedAtUtc { get; init; }
}

/// <summary>Only bounded facts from the exact accepted interval.</summary>
public sealed record ConnectivityCorrelationIntervalDto
{
    /// <summary>First probe measurement time.</summary>
    public DateTimeOffset FirstObservedUtc { get; init; }
    /// <summary>Last probe measurement time.</summary>
    public DateTimeOffset LastObservedUtc { get; init; }
    /// <summary>Server receipt of accepted evidence.</summary>
    public DateTimeOffset ReceivedUtc { get; init; }
    /// <summary>Replies in interval.</summary>
    public int SuccessCount { get; init; }
    /// <summary>Completed nonreplies in interval.</summary>
    public int FailureCount { get; init; }
    /// <summary>Local probe errors in interval.</summary>
    public int ErrorCount { get; init; }
    /// <summary>Optional bounded source-only profile clue, not a cause verdict.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public SourceFirewallCheck? SourceFirewallCheck { get; init; }
}

/// <summary>Operator annotation for an accepted connectivity incident, not current health.</summary>
public sealed record ConnectivityAlertDto
{
    /// <summary>Alert identifier.</summary>
    public Guid Id { get; init; }
    /// <summary>Immutable source cabinet identity.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Measured destination cabinet identity.</summary>
    public Guid TargetCabinetId { get; init; }
    /// <summary>Accepted summary that established this incident.</summary>
    public Guid EvidenceId { get; init; }
    /// <summary>Current site identity of the source cabinet.</summary>
    public Guid SiteId { get; init; }
    /// <summary>Current source client label.</summary>
    public string ClientName { get; init; } = string.Empty;
    /// <summary>Current source site label.</summary>
    public string SiteName { get; init; } = string.Empty;
    /// <summary>Current source friendly label or hostname.</summary>
    public string SourceName { get; init; } = string.Empty;
    /// <summary>Incident time, unknown when the aggregate cannot establish it.</summary>
    public DateTimeOffset? ObservedUtc { get; init; }
    /// <summary>Server reception of incident evidence.</summary>
    public DateTimeOffset ReceivedUtc { get; init; }
    /// <summary>Accepted source and target interval facts behind this incident, if retained.</summary>
    public ConnectivitySummary? IncidentEvidence { get; init; }
    /// <summary>Optional source-only firewall profile check attached to the accepted incident evidence.</summary>
    public SourceFirewallCheck? SourceFirewallCheck { get; init; }
    /// <summary>Operator label for the limited source-side clue. Does not diagnose causation.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string SourceFirewallClueLabel => SourceFirewallCheck is not { } check ? "Unknown (not checked)" :
        check.HasOutboundProfileBlockClue switch
        {
            true => "Possible source outbound firewall block (not confirmed cause)",
            false => "No coarse source outbound block seen; firewall not ruled out",
            _ => check.Status switch
            {
                FirewallReadStatus.Read or FirewallReadStatus.Partial => "Unknown (inconclusive)",
                FirewallReadStatus.AccessDenied => "Unknown (access denied)",
                FirewallReadStatus.Unsupported => "Unknown (unsupported)",
                _ => "Unknown (read unavailable)"
            }
        };
    /// <summary>Open, Acknowledged or Resolved. Independent of measured reachability.</summary>
    public string Status { get; init; } = "Open";
    /// <summary>Most recent operator note.</summary>
    public string? Note { get; init; }
    /// <summary>Most recent operator annotation time.</summary>
    public DateTimeOffset? UpdatedUtc { get; init; }
}

/// <summary>Server snapshot of retained incident annotation workload for a source site, not measured health.</summary>
public sealed record ConnectivitySiteWorkloadDto
{
    /// <summary>Current source-site identity, not an incident-time site snapshot.</summary>
    public Guid SiteId { get; init; }
    /// <summary>Server time when the grouped query was requested.</summary>
    public DateTimeOffset AsOfUtc { get; init; }
    /// <summary>Retained incidents awaiting operator acknowledgment.</summary>
    public int Open { get; init; }
    /// <summary>Retained incidents acknowledged but not resolved.</summary>
    public int Acknowledged { get; init; }
    /// <summary>Retained incidents manually resolved; not proof of restored connectivity.</summary>
    public int Resolved { get; init; }
    /// <summary>All retained incident annotations at this source site.</summary>
    public int Total => Open + Acknowledged + Resolved;
}

/// <summary>Bounded connectivity incident queue query.</summary>
public sealed record ConnectivityAlertQuery : PagedQuery
{
    /// <summary>Optional current site scope for the source cabinet.</summary>
    public Guid? SiteId { get; init; }
    /// <summary>Optional immutable source filter.</summary>
    public Guid? SourceCabinetId { get; init; }
    /// <summary>Include resolved annotations.</summary>
    public bool IncludeResolved { get; init; }
}

/// <summary>Support annotation with an explicit source identity check.</summary>
public sealed record AnnotateConnectivityAlertRequest
{
    /// <summary>Source cabinet the operator intends to annotate.</summary>
    public Guid SourceCabinetId { get; init; }
    /// <summary>Required reason, not a measured health result.</summary>
    [Required, MaxLength(1000)]
    public required string Note { get; init; }
}
