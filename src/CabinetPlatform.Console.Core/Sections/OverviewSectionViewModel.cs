using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// Who and what this machine is: identity, where it lives, and how long since
/// it last said anything.
/// </summary>
public sealed partial class OverviewSectionViewModel : MachineSectionViewModel
{
    public OverviewSectionViewModel()
        : base("Overview",
            "Hostname, client, site and department, operating system, uptime, " +
            "check-in age, agent version, and whether a user is logged on.")
    {
        // The one section open by default: it is what the engineer is looking
        // at while they decide which other section to open.
        IsExpanded = true;
    }

    [ObservableProperty] private string _hostname = Format.NotReported;
    [ObservableProperty] private string _machineId = Format.NotReported;
    [ObservableProperty] private string _client = Format.NotReported;
    [ObservableProperty] private string _site = Format.NotReported;
    [ObservableProperty] private string _department = Format.NotReported;
    [ObservableProperty] private string _role = Format.NotReported;
    [ObservableProperty] private string _syncCabinet = Format.NotReported;
    [ObservableProperty] private string _model = Format.NotReported;
    [ObservableProperty] private string _serialNumber = Format.NotReported;
    [ObservableProperty] private string _osVersion = Format.NotReported;
    [ObservableProperty] private string _agentVersion = Format.NotReported;
    [ObservableProperty] private string _uptime = Format.NotReported;
    [ObservableProperty] private string _lastCheckInAge = "Never";
    [ObservableProperty] private string _lastCheckInExact = Format.NotReported;
    [ObservableProperty] private string _collectedAt = Format.NotReported;

    [ObservableProperty]
    private StatusPresentation _health = StatusPresentation.Unknown;

    [ObservableProperty]
    private StatusPresentation _active = StatusPresentation.Unknown;

    /// <summary>
    /// Whether anyone is using the cabinet right now. Kept prominent because it
    /// is the gate on every disruptive action: an engineer about to request a
    /// reboot needs to see it before they click, not in the refusal afterwards.
    /// </summary>
    [ObservableProperty]
    private StatusPresentation _loggedOn = StatusPresentation.Unknown;

    /// <summary>
    /// OS build is not reported separately by this server's contract, which
    /// carries one free-text OS version string. Stated rather than faked out of
    /// the version string, which would be a guess presented as a reading.
    /// </summary>
    public string OsBuildNote =>
        "The server's check-in contract carries one operating system version string and no " +
        "separate build number.";

    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        if (latest is null)
        {
            Hostname = MachineId = Client = Site = Department = Role = SyncCabinet = Model =
                SerialNumber = OsVersion = AgentVersion = Uptime = LastCheckInExact = CollectedAt =
                CabinetLocalTime = ClockDrift = SyncLinkDetail = Format.NotReported;
            LastCheckInAge = "Never";
            Health = Active = LoggedOn = SyncLink = StatusPresentation.Unknown;
            CanTestSyncLink = false;
            Availability = SectionAvailability.NoCheckIn;
            return;
        }

        CabinetSummary cabinet = latest.Cabinet;

        // Identity comes from the cabinet record — approved by a Supervisor —
        // not from whatever the agent last claimed about itself.
        Hostname = Format.Text(cabinet.Hostname);
        MachineId = Format.Text(cabinet.MachineId);
        Client = Format.Text(cabinet.ClientName);
        Site = Format.Text(cabinet.SiteName);
        Department = Format.Text(cabinet.DepartmentName);
        ApplyTopology(latest, nowUtc);
        Model = Format.Text(cabinet.Model);
        SerialNumber = Format.Text(cabinet.SerialNumber);
        AgentVersion = Format.Text(cabinet.AgentVersion);

        Health = StatusPresentation.ForCabinet(cabinet.Health);
        Active = StatusPresentation.ForBoolean(cabinet.IsActive, "Active", "Inactive");

        LastCheckInAge = Format.Age(cabinet.LastCheckInUtc, nowUtc);
        LastCheckInExact = Format.LocalTime(cabinet.LastCheckInUtc);

        HeartbeatDto? check = latest.LatestHeartbeat;

        // The cabinet's local time sits beside the rep's own, because "02:00"
        // means nothing across thirteen countries without saying whose.
        CabinetLocalTime = Format.CabinetTime(latest.CabinetLocalTime, cabinet.TimeZoneId);
        ClockDrift = cabinet.ClockDrift is { } drift
            ? Format.Duration(drift.Duration())
            : Format.NotReported;

        if (check is null)
        {
            // The cabinet exists and was approved, but nothing has arrived from
            // it. Identity above is still real and still worth showing.
            Availability = SectionAvailability.NoCheckIn;
            OsVersion = Format.NotReported;
            Uptime = Format.NotReported;
            CollectedAt = Format.NotReported;
            LoggedOn = StatusPresentation.Unknown;
            return;
        }

        Availability = SectionAvailability.Available;
        CollectedAt = Format.LocalTime(check.CollectedAtUtc);

        // The operating system is inventory, not a heartbeat field: it changes
        // on a servicing, not every five minutes.
        OsVersion = Format.Text(latest.CurrentInventory?.System?.OsVersion);
        Uptime = Format.Duration(check.Uptime);

        LoggedOn = StatusPresentation.ForBoolean(
            check.AnyUserLoggedOn, "A user is logged on", "Nobody is logged on");
    }

    /// <summary>
    /// Where this cabinet sits in its site, and how it is currently reaching
    /// the cabinet that syncs the site.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A whole site misbehaving usually means one satellite has lost its sync
    /// cabinet, and that is a fact nobody can read off the fleet view: the sync
    /// cabinet can be perfectly reachable from the server and unreachable from
    /// the satellite standing next to it. The two are different questions, and
    /// only the second one explains the site.
    /// </para>
    /// <para>
    /// So this is never inferred from the sync cabinet being online. It is the
    /// result of a probe run from this cabinet, or it says that none has been
    /// run.
    /// </para>
    /// </remarks>
    private void ApplyTopology(CabinetDetailDto latest, DateTimeOffset nowUtc)
    {
        Role = latest.Cabinet.Role switch
        {
            CabinetRole.Sync => "Sync cabinet — this site's data lives here",
            CabinetRole.Satellite => "Satellite — syncs against another cabinet at this site",
            CabinetRole.Standalone => "Standalone — this site has no sync cabinet",
            _ => Format.NotReported,
        };

        if (latest.Cabinet.Role == CabinetRole.Sync)
        {
            SyncCabinet = "This cabinet is its site's sync cabinet.";
            SyncLink = StatusPresentation.Unknown;
            SyncLinkDetail = "A sync cabinet does not probe itself.";
            CanTestSyncLink = false;
            return;
        }

        if (latest.SyncCabinetLink is not { } link)
        {
            SyncCabinet = latest.Site.SyncCabinetId is null
                ? "This site has no sync cabinet."
                : Format.NotReported;

            SyncLink = StatusPresentation.Unknown;
            SyncLinkDetail = latest.Site.SyncCabinetId is null
                ? "A standalone site has no link to test."
                : "The site's sync cabinet could not be resolved.";
            CanTestSyncLink = false;
            return;
        }

        SyncCabinet = $"{link.SyncCabinetHostname} " +
                      $"({StatusPresentation.ForCabinet(link.SyncCabinetHealth).Label})";

        CanTestSyncLink = true;

        (SyncLink, SyncLinkDetail) = link.LastProbeReachable switch
        {
            true => (
                new StatusPresentation("Reachable", "✔", StatusSeverity.Good),
                $"Reached {Format.Age(link.LastProbeUtc, nowUtc)}" +
                (link.LastProbeLatencyMs is { } ms ? $", {ms:F0} ms round trip." : ".")),

            false => (
                new StatusPresentation("Unreachable", "✖", StatusSeverity.Critical),
                $"This cabinet could not reach its sync cabinet {Format.Age(link.LastProbeUtc, nowUtc)}. " +
                "That is a different fact from the sync cabinet being offline, and it is the one " +
                "that explains a site out of step."),

            null => (
                StatusPresentation.Unknown,
                "No probe has been run from this cabinet. Whether the sync cabinet is reachable " +
                "from here is not known, and is not implied by it being online."),
        };
    }

    /// <summary>How this cabinet is currently reaching its site's sync cabinet.</summary>
    [ObservableProperty]
    private StatusPresentation _syncLink = StatusPresentation.Unknown;

    /// <summary>The probe result in words, including when it was taken.</summary>
    [ObservableProperty]
    private string _syncLinkDetail =
        "No probe has been run from this cabinet.";

    /// <summary>
    /// Whether the one-click link test is worth offering: there is a sync
    /// cabinet, and it is not this one.
    /// </summary>
    [ObservableProperty]
    private bool _canTestSyncLink;

    /// <summary>The cabinet's own local time, labelled with its zone.</summary>
    public string CabinetLocalTime { get; private set; } = Format.NotReported;

    /// <summary>How far the cabinet's clock sits from the server's.</summary>
    public string ClockDrift { get; private set; } = Format.NotReported;

    public override string Summarise() =>
        Availability.HasData
            ? $"{Hostname} at {Client}, {Site}. {Role}. Health {Health.Label}. " +
              $"Last check-in {LastCheckInAge}. {LoggedOn.Label}. " +
              $"Sync cabinet {SyncCabinet}: {SyncLink.Label}."
            : $"Overview: {Availability.Reason}";
}
