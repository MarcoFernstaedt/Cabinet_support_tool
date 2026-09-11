using System.ComponentModel.DataAnnotations;
using Mashura.CabinetSupport.Contracts.Agent;
using Mashura.CabinetSupport.Contracts.Common;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Contracts.Cabinets;

/// <summary>
/// The list-view shape. Deliberately flat and payload-free: the server projects
/// straight to these columns so a ten-thousand-cabinet page never deserialises
/// a stored check-in payload.
/// </summary>
public sealed class CabinetSummary
{
    public Guid Id { get; set; }
    public string MachineId { get; set; } = string.Empty;
    public string Hostname { get; set; } = string.Empty;
    public string ClientName { get; set; } = string.Empty;
    public string SiteName { get; set; } = string.Empty;
    public string? DepartmentName { get; set; }
    public string? Model { get; set; }
    public string? SerialNumber { get; set; }
    public bool IsActive { get; set; }
    public DateTime? LastCheckInUtc { get; set; }
    public string? AgentVersion { get; set; }

    public CabinetHealthStatus Health { get; set; }
    public double? CpuPercent { get; set; }
    public double? RamUsedPercent { get; set; }
    public double? MinFreeDiskPercent { get; set; }
    public int? PendingUpdateCount { get; set; }
    public DiskHealthStatus? WorstDiskHealth { get; set; }
    public bool? AnyUserLoggedOn { get; set; }
}

public sealed class CabinetQuery : PagedQuery
{
    [StringLength(255)]
    public string? ClientName { get; set; }

    [StringLength(255)]
    public string? SiteName { get; set; }

    [StringLength(255)]
    public string? Search { get; set; }

    public bool? IsActive { get; set; }
    public CabinetHealthStatus? Health { get; set; }
}

/// <summary>The most recent observation for one cabinet, payload included.</summary>
public sealed class CabinetLatestDto
{
    public CabinetSummary Cabinet { get; set; } = new();
    public CheckInDetailDto? LatestCheckIn { get; set; }
    public IReadOnlyList<SmartReadingDto> LatestSmartReadings { get; set; } = Array.Empty<SmartReadingDto>();
}

/// <summary>A check-in row as it appears in a paged history list — no payload.</summary>
public sealed class CheckInSummaryDto
{
    public Guid Id { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime CollectedAtUtc { get; set; }
    public double CpuPercent { get; set; }
    public double RamUsedPercent { get; set; }
    public double MinFreeDiskPercent { get; set; }
    public int PendingUpdateCount { get; set; }
    public DiskHealthStatus WorstDiskHealth { get; set; }
    public bool AnyUserLoggedOn { get; set; }
}

/// <summary>A single check-in with the verbatim payload the agent sent.</summary>
public sealed class CheckInDetailDto
{
    public Guid Id { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime CollectedAtUtc { get; set; }
    public double CpuPercent { get; set; }
    public double RamUsedPercent { get; set; }
    public double MinFreeDiskPercent { get; set; }
    public int PendingUpdateCount { get; set; }
    public DiskHealthStatus WorstDiskHealth { get; set; }
    public bool AnyUserLoggedOn { get; set; }
    public CheckInRequest? Payload { get; set; }
}

/// <summary>
/// A bounded time window. Unbounded history queries are rejected rather than
/// silently clamped, so the caller learns their query was wrong.
/// </summary>
public class HistoryQuery : PagedQuery
{
    public DateTime? FromUtc { get; set; }
    public DateTime? ToUtc { get; set; }
}

public sealed class SmartReadingDto
{
    public Guid Id { get; set; }
    public string DriveSerial { get; set; } = string.Empty;
    public string? DriveModel { get; set; }
    public DateTime TimestampUtc { get; set; }
    public DiskHealthStatus PredictedHealth { get; set; }

    /// <summary>True when this row is a daily roll-up of aged-out readings.</summary>
    public bool IsAggregated { get; set; }

    public long? ReallocatedSectorCount { get; set; }
    public long? ReportedUncorrectableErrors { get; set; }
    public long? CommandTimeoutCount { get; set; }
    public long? CurrentPendingSectorCount { get; set; }
    public long? OfflineUncorrectableCount { get; set; }
    public long? UdmaCrcErrorCount { get; set; }
    public long? SpinRetryCount { get; set; }
    public long? SeekErrorRate { get; set; }
    public long? ReadErrorRate { get; set; }
    public long? WearLevelingCount { get; set; }
    public int? PercentageUsed { get; set; }
    public int? AvailableSparePercent { get; set; }
    public int? AvailableSpareThresholdPercent { get; set; }
    public long? MediaAndDataIntegrityErrors { get; set; }
    public long? UnsafeShutdownCount { get; set; }
    public long? PowerOnHours { get; set; }
    public long? PowerCycleCount { get; set; }
    public int? TemperatureCelsius { get; set; }
    public long? TotalHostReadsGb { get; set; }
    public long? TotalHostWritesGb { get; set; }
}

public sealed class SmartHistoryQuery : HistoryQuery
{
    [StringLength(128)]
    public string? DriveSerial { get; set; }
}

/// <summary>Aggregate fleet counts for the dashboard's top row.</summary>
public sealed class FleetHealthSummary
{
    public int TotalCabinets { get; set; }
    public int Healthy { get; set; }
    public int Warning { get; set; }
    public int Critical { get; set; }
    public int Offline { get; set; }
    public int Unknown { get; set; }
    public int Inactive { get; set; }
    public int PendingRegistrations { get; set; }
    public int ActionsAwaitingApproval { get; set; }
    public DateTime GeneratedUtc { get; set; }
}

public sealed class FleetHealthQuery
{
    [StringLength(255)]
    public string? ClientName { get; set; }

    [StringLength(255)]
    public string? SiteName { get; set; }
}
