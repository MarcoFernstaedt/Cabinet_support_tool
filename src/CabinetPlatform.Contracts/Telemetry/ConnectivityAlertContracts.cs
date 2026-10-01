using System.ComponentModel.DataAnnotations;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Telemetry;

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
