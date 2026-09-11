using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Server.Domain;

/// <summary>
/// An agent that has announced itself but has not been let in. Until a
/// Supervisor approves it, nothing it reports is stored or shown as fleet data.
/// </summary>
public class PendingRegistration
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string MachineId { get; set; } = string.Empty;
    public string Hostname { get; set; } = string.Empty;
    public string? OsVersion { get; set; }
    public string? AgentVersion { get; set; }

    public DateTimeOffset FirstSeenUtc { get; set; }
    public DateTimeOffset LastSeenUtc { get; set; }

    public RegistrationStatus Status { get; set; } = RegistrationStatus.Pending;

    public Guid? DecidedByUserId { get; set; }
    public DateTimeOffset? DecidedUtc { get; set; }
}
