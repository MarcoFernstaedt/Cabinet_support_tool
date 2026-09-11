using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One cabinet in the list, pre-formatted for display and for reading aloud.</summary>
public sealed class CabinetRow
{
    public CabinetRow(CabinetSummary summary, DateTime nowUtc)
    {
        Summary = summary;
        Health = StatusPresentation.ForCabinet(summary.Health);
        DiskHealth = summary.WorstDiskHealth is { } disk
            ? StatusPresentation.ForDisk(disk)
            : StatusPresentation.Unknown;
        LastCheckInAge = Format.Age(summary.LastCheckInUtc, nowUtc);
        LastCheckInExact = Format.LocalTime(summary.LastCheckInUtc);
    }

    public CabinetSummary Summary { get; }

    public Guid Id => Summary.Id;
    public string Hostname => Summary.Hostname;
    public string ClientName => Summary.ClientName;
    public string SiteName => Summary.SiteName;
    public string Department => Format.Text(Summary.DepartmentName);
    public bool IsActive => Summary.IsActive;

    public StatusPresentation Health { get; }
    public StatusPresentation DiskHealth { get; }

    public string LastCheckInAge { get; }
    public string LastCheckInExact { get; }

    public string Cpu => Format.Percent(Summary.CpuPercent);
    public string Ram => Format.Percent(Summary.RamUsedPercent);
    public string FreeDisk => Format.Percent(Summary.MinFreeDiskPercent);
    public string PendingUpdates => Format.Count(Summary.PendingUpdateCount);

    /// <summary>
    /// Inactive cabinets stay in the list rather than disappearing, so the
    /// reason a cabinet cannot be actioned is legible instead of mysterious.
    /// </summary>
    public string ActiveLabel => Summary.IsActive ? "Active" : "Inactive";

    /// <summary>
    /// The whole row as one sentence, so a screen reader user hears the state of
    /// a cabinet on arrow-down without having to traverse nine columns.
    /// </summary>
    public string AccessibleSummary =>
        $"{Summary.Hostname}, {Summary.ClientName}, {Summary.SiteName}. " +
        $"Health {Health.Label}. Last check-in {LastCheckInAge}. " +
        $"Disk {DiskHealth.Label}. {PendingUpdates} pending updates. " +
        (Summary.IsActive ? "Active." : "Inactive.");
}
