namespace CabinetPlatform.Server.Domain;

/// <summary>Non-credential reservation; never an approved cabinet or pending agent registration.</summary>
public sealed class SuccessorReservation
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid PredecessorCabinetId { get; set; }
    public Cabinet? PredecessorCabinet { get; set; }
    public string SuccessorMachineId { get; set; } = string.Empty;
    public Guid ReservedByUserId { get; set; }
    public DateTimeOffset ReservedUtc { get; set; }
}
