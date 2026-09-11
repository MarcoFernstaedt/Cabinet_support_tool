using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Server.Domain;

/// <summary>
/// An approved cabinet PC. A row here exists only because a Supervisor decided
/// it should; an agent cannot create one by asserting anything about itself.
/// </summary>
public class Cabinet
{
    /// <summary>Identifier of the cabinet.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Agent-supplied stable machine identity. Unique across the fleet.</summary>
    public string MachineId { get; set; } = string.Empty;

    /// <summary>Current hostname, as the agent last reported it. Display only.</summary>
    public string Hostname { get; set; } = string.Empty;

    /// <summary>Site this cabinet sits at. Assigned by the approving Supervisor.</summary>
    public Guid SiteId { get; set; }

    /// <summary>Navigation to that site.</summary>
    public Site? Site { get; set; }

    /// <summary>Department within the site, when the client uses them.</summary>
    public string? DepartmentName { get; set; }

    /// <summary>
    /// This cabinet's part in its site's topology. Set at approval and
    /// changeable later by a Supervisor, audited either way. Never settable by
    /// the agent.
    /// </summary>
    public CabinetRole Role { get; set; } = CabinetRole.Unknown;

    /// <summary>Cabinet model, when known.</summary>
    public string? Model { get; set; }

    /// <summary>Cabinet serial number, when known.</summary>
    public string? SerialNumber { get; set; }

    /// <summary>
    /// The cabinet's own time zone, taken from the agent's reported system
    /// information. Maintenance windows and scheduled installs are evaluated in
    /// this zone — never the server's and never the rep's.
    /// </summary>
    public string? TimeZoneId { get; set; }

    /// <summary>
    /// Last local address the agent reported for its primary adapter. This is
    /// what the server resolves a cabinet-to-cabinet probe against, so that a
    /// rep names a cabinet and never an address.
    /// </summary>
    public string? LastKnownIpAddress { get; set; }

    /// <summary>UTC instant the Supervisor admitted this machine.</summary>
    public DateTimeOffset ApprovedUtc { get; set; }

    /// <summary>Which Supervisor admitted it.</summary>
    public Guid ApprovedByUserId { get; set; }

    /// <summary>
    /// Deactivating a cabinet stops it reporting immediately: check-in checks
    /// this, so a decommissioned machine cannot keep feeding the fleet view.
    /// </summary>
    public bool IsActive { get; set; } = true;

    /// <summary>UTC instant of the most recent check-in of any tier.</summary>
    public DateTimeOffset? LastCheckInUtc { get; set; }

    /// <summary>UTC instant of the most recent full-tier check-in.</summary>
    public DateTimeOffset? LastFullCheckInUtc { get; set; }

    /// <summary>Version of the agent that last reported.</summary>
    public string? AgentVersion { get; set; }

    /// <summary>
    /// The inventory version currently in force, or null if none has been
    /// stored. Holding the pointer here is what lets an unchanged inventory
    /// check-in write nothing at all.
    /// </summary>
    public Guid? CurrentInventoryVersionId { get; set; }

    /// <summary>
    /// Optimistic concurrency token. Two Supervisors changing a cabinet's role
    /// at once must not silently overwrite one another.
    /// </summary>
    public byte[]? RowVersion { get; set; }
}
