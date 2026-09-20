namespace CabinetPlatform.Server.Domain;

/// <summary>Bounded operator workflow, independent of immutable connectivity evidence.</summary>
public sealed class ConnectivityAlert
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid SourceCabinetId { get; set; }
    public Cabinet? SourceCabinet { get; set; }
    public Guid TargetCabinetId { get; set; }
    public Guid EvidenceId { get; set; }
    public DateTimeOffset? ObservedUtc { get; set; }
    public DateTimeOffset ReceivedUtc { get; set; }
    public string Status { get; set; } = "Open";
    public string? Note { get; set; }
    public Guid? UpdatedByUserId { get; set; }
    public DateTimeOffset? UpdatedUtc { get; set; }
}
