namespace CabinetPlatform.Server.Domain;

/// <summary>One explicitly approved bounded target set per source cabinet.</summary>
public sealed class ConnectivityConfiguration
{
    public Guid SourceCabinetId { get; set; }
    public Guid ConfigurationId { get; set; }
    public Guid SiteId { get; set; }
    public string TargetsJson { get; set; } = "[]";
    public DateTimeOffset UpdatedUtc { get; set; }
    public string StatesJson { get; set; } = "[]";
}

/// <summary>Immutable bounded interval evidence, independent of derived classification.</summary>
public sealed class ConnectivityEvidence
{
    public Guid Id { get; set; }
    public Guid SourceCabinetId { get; set; }
    public Guid TargetCabinetId { get; set; }
    public Guid ConfigurationId { get; set; }
    public DateTimeOffset FirstObservedUtc { get; set; }
    public DateTimeOffset ObservedUtc { get; set; }
    public DateTimeOffset ReceivedUtc { get; set; }
    public string SummaryJson { get; set; } = string.Empty;
}
