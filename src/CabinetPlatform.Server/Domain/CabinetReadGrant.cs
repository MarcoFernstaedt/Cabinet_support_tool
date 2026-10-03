namespace CabinetPlatform.Server.Domain;

/// <summary>Explicit permission for one staff user to read one cabinet through the demo route.</summary>
public sealed class CabinetReadGrant
{
    public Guid UserId { get; set; }
    public User? User { get; set; }
    public Guid CabinetId { get; set; }
    public Cabinet? Cabinet { get; set; }
}
