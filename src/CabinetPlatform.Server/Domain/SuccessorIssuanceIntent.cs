namespace CabinetPlatform.Server.Domain;

/// <summary>Uncredentialed operator intent only; no enrollment or activation authority.</summary>
public sealed class SuccessorIssuanceIntent
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid PredecessorCabinetId { get; set; }
    public Cabinet? PredecessorCabinet { get; set; }
    public Guid ReservationId { get; set; }
    public SuccessorReservation? Reservation { get; set; }
    public Guid RequestId { get; set; }
    public string ProposedKeyHash { get; set; } = string.Empty;
    public Guid RequestedByUserId { get; set; }
    public DateTimeOffset RequestedUtc { get; set; }
}
