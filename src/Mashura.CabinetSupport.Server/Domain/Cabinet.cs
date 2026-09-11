namespace Mashura.CabinetSupport.Server.Domain;

/// <summary>
/// An approved cabinet PC. A row here exists only because a Supervisor decided
/// it should; an agent cannot create one by asserting anything about itself.
/// </summary>
public class Cabinet
{
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Agent-supplied stable machine identity. Unique across the fleet.</summary>
    public string MachineId { get; set; } = string.Empty;

    public string Hostname { get; set; } = string.Empty;

    /// <summary>Assigned by the approving Supervisor, never by the agent.</summary>
    public string ClientName { get; set; } = string.Empty;

    public string SiteName { get; set; } = string.Empty;
    public string? DepartmentName { get; set; }
    public string? Model { get; set; }
    public string? SerialNumber { get; set; }

    public DateTime ApprovedUtc { get; set; }
    public Guid ApprovedByUserId { get; set; }

    /// <summary>
    /// Deactivating a cabinet stops it reporting immediately: check-in checks
    /// this, so a decommissioned machine cannot keep feeding the fleet view.
    /// </summary>
    public bool IsActive { get; set; } = true;

    public DateTime? LastCheckInUtc { get; set; }
    public string? AgentVersion { get; set; }
}
