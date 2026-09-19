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
    /// <summary>Creates the row.</summary>
    /// <param name="summary">The cabinet.</param>
    /// <param name="nowUtc">The current instant, for the check-in age.</param>
    /// <param name="hostnameIsAmbiguous">
    /// Whether another cabinet on the same page carries this name.
    /// </param>
    public CabinetRow(CabinetSummary summary, DateTimeOffset nowUtc, bool hostnameIsAmbiguous = false)
    {
        Summary = summary;
        Path = CabinetPath.From(summary, hostnameIsAmbiguous);
        Health = MonitoringFreshness.ForCabinet(summary.Health, summary.LastCheckInUtc, nowUtc);
        DiskHealth = summary.WorstDiskHealth is { } disk
            ? MonitoringFreshness.Historical(StatusPresentation.ForDisk(disk))
            : StatusPresentation.Unknown;
        LastCheckInAge = Format.Age(summary.LastCheckInUtc, nowUtc);
        LastCheckInExact = MonitoringFreshness.LastSeen(summary.LastCheckInUtc);
    }

    /// <summary>The cabinet as the server projected it.</summary>
    public CabinetSummary Summary { get; }

    /// <summary>Its full identifying path.</summary>
    public CabinetPath Path { get; }

    /// <summary>Identifier of the cabinet.</summary>
    public Guid Id => Summary.Id;

    /// <summary>
    /// The cabinet's own name.
    /// </summary>
    /// <remarks>
    /// Never shown alone. Hostnames repeat freely across three and a half
    /// thousand client organisations, so any column showing this one sits
    /// beside the client and the site, and anything a person reads to decide
    /// what to do reads <see cref="Display"/> instead.
    /// </remarks>
    public string Hostname => Summary.Hostname;

    /// <summary>The one-line identification: client, site, department, name, role.</summary>
    public string Display => Path.Display;

    /// <summary>Its part in its site's topology, as a person reads it.</summary>
    public string RoleLabel => CabinetIdentity.RoleLabel(Summary.Role);

    /// <summary>Whether another cabinet on this page carries the same name.</summary>
    public bool HasDuplicateName => Path.HostnameIsAmbiguous;

    /// <summary>The duplicate-name marker, or empty when the name is unique here.</summary>
    public string DuplicateNameMarker => HasDuplicateName ? CabinetIdentity.AmbiguityMarker : string.Empty;

    /// <summary>Client this cabinet belongs to.</summary>
    public string ClientName => Summary.ClientName;

    /// <summary>Site within that client.</summary>
    public string SiteName => Summary.SiteName;

    /// <summary>Department, or a dash when the client does not use them.</summary>
    public string Department => Format.Text(Summary.DepartmentName);

    /// <summary>Whether the cabinet is in service.</summary>
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
        $"{Path.Spoken} Health {Health.Label}. {LastCheckInExact}. Check-in age at load: {LastCheckInAge}. " +
        $"Disk {DiskHealth.Label}. {PendingUpdates} pending updates. " +
        (Summary.IsActive ? "Active." : "Inactive.");
}
