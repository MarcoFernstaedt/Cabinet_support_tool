using CabinetPlatform.Contracts.Enums;

namespace CabinetPlatform.Server.Domain;

/// <summary>
/// One observation from one cabinet. The raw payload is kept verbatim for
/// forensics, and the handful of fields the fleet views actually filter and
/// sort on are projected into real columns beside it. List queries read only
/// the columns — deserialising ten thousand payloads to draw a grid is how
/// this table stops working.
/// </summary>
public class CheckIn
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid CabinetId { get; set; }
    public Cabinet? Cabinet { get; set; }

    /// <summary>When the server accepted it.</summary>
    public DateTime ReceivedUtc { get; set; }

    /// <summary>
    /// When the agent sampled it. Unique per cabinet: a retried check-in
    /// carrying a timestamp already stored is acknowledged, not duplicated.
    /// </summary>
    public DateTime CollectedAtUtc { get; set; }

    /// <summary>The agent's message exactly as received. Never read by list views.</summary>
    public string PayloadJson { get; set; } = string.Empty;

    // --- Projected columns: everything the fleet view queries on ----------
    public double CpuPercent { get; set; }
    public double RamUsedPercent { get; set; }
    public double MinFreeDiskPercent { get; set; }
    public int PendingUpdateCount { get; set; }
    public DiskHealthStatus WorstDiskHealth { get; set; }
    public bool AnyUserLoggedOn { get; set; }
}
