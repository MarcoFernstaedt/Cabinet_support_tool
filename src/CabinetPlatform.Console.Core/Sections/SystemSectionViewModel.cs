using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// Operating system, domain membership, time zone, clock drift and installed
/// software — and the reboot action.
/// </summary>
/// <remarks>
/// Reboot is the most consequential thing this console can ask for: disruptive,
/// approval-required, evaluated against the cabinet's own maintenance window,
/// and refused outright while anyone is logged on — or while the cabinet cannot
/// say whether anyone is. It sits here, in the section it belongs to, with all
/// of those facts on the button.
/// </remarks>
public sealed partial class SystemSectionViewModel : MachineSectionViewModel
{
    /// <summary>Creates the section.</summary>
    public SystemSectionViewModel()
        : base("System",
            "Operating system and build, install date, domain or workgroup, time zone, clock " +
            "drift against the server, and installed software. The reboot action is inside " +
            "this section.")
    {
    }

    /// <summary>Operating system product name.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _osVersion = Format.NotReported;

    /// <summary>Operating system build number.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _osBuild = Format.NotReported;

    /// <summary>When the operating system was installed.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _installDate = Format.NotReported;

    /// <summary>Domain or workgroup the machine belongs to.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _domain = Format.NotReported;

    /// <summary>The cabinet's own time zone.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _timeZone = Format.NotReported;

    /// <summary>The cabinet's current local time, labelled with its zone.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _cabinetLocalTime = Format.NotReported;

    /// <summary>
    /// How far the cabinet's clock sits from the server's.
    /// </summary>
    /// <remarks>
    /// Worth its own line: drift breaks site synchronisation and the ordering of
    /// audit records against a dispensing system's own log, and neither failure
    /// announces itself at the time.
    /// </remarks>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private string _clockDrift = Format.NotReported;

    /// <summary>Whether the drift is far enough to matter.</summary>
    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]
    private StatusPresentation _clockDriftStatus = StatusPresentation.Unknown;

    /// <summary>Installed software, as the last inventory reported it.</summary>
    public ObservableCollection<InstalledSoftwareInfo> InstalledSoftware { get; } = new();

    /// <inheritdoc />
    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        InstalledSoftware.Clear();
        OsVersion = OsBuild = InstallDate = Domain = TimeZone = CabinetLocalTime = ClockDrift = Format.NotReported;
        ClockDriftStatus = StatusPresentation.Unknown;

        if (latest is null)
        {
            Availability = SectionAvailability.NoCheckIn;
            return;
        }

        TimeZone = Format.Text(latest.Cabinet.TimeZoneId);
        CabinetLocalTime = Format.CabinetTime(latest.CabinetLocalTime, latest.Cabinet.TimeZoneId);

        (ClockDrift, ClockDriftStatus) = latest.Cabinet.ClockDrift is { } drift
            ? (Format.Duration(drift.Duration()), DescribeDrift(drift))
            : (Format.NotReported, StatusPresentation.Unknown);

        SystemInfo? system = latest.CurrentInventory?.System;

        if (system is null)
        {
            Availability = latest.CurrentInventory is null
                ? SectionAvailability.NoInventoryYet(Title)
                : SectionAvailability.CollectorFailed(Title);
            return;
        }

        Availability = SectionAvailability.Available;
        OsVersion = Format.Text(system.OsVersion);
        OsBuild = Format.Text(system.OsBuild);
        InstallDate = Format.LocalTime(system.InstallDateUtc);
        Domain = Format.Text(system.DomainOrWorkgroup);

        foreach (InstalledSoftwareInfo software in
                 system.InstalledSoftware ?? Array.Empty<InstalledSoftwareInfo>())
        {
            InstalledSoftware.Add(software);
        }

        _ = nowUtc;
    }

    /// <inheritdoc />
    public override string Summarise() =>
        Availability.HasData
            ? $"System: {OsVersion} build {OsBuild}. Domain {Domain}. Cabinet time " +
              $"{CabinetLocalTime}. Clock drift {ClockDrift}. " +
              $"{InstalledSoftware.Count} installed program(s)."
            : $"System: {Availability.Reason}";

    private static StatusPresentation DescribeDrift(TimeSpan drift) => drift.Duration() switch
    {
        var d when d >= TimeSpan.FromMinutes(10) =>
            new StatusPresentation("Far enough to break audit ordering", "✖", StatusSeverity.Critical),
        var d when d >= TimeSpan.FromMinutes(2) =>
            new StatusPresentation("Drifting", "▲", StatusSeverity.Warning),
        _ => new StatusPresentation("In step with the server", "✔", StatusSeverity.Good),
    };
}
