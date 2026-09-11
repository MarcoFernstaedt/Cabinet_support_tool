using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Agent;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// Pending Windows updates, whether a reboot is waiting on them, and the two
/// actions that move them along.
/// </summary>
public sealed partial class WindowsUpdateSectionViewModel : MachineSectionViewModel
{
    public WindowsUpdateSectionViewModel()
        : base("Windows Update",
            "Pending updates, their count, and whether a reboot is pending. " +
            "Scan for updates and schedule updates actions are inside this section.")
    {
    }

    public ObservableCollection<PendingUpdateRow> PendingUpdates { get; } = new();

    [ObservableProperty]
    private string _pendingCount = Format.NotReported;

    [ObservableProperty]
    private StatusPresentation _rebootPending = StatusPresentation.Unknown;

    [ObservableProperty]
    private StatusPresentation _securityPending = StatusPresentation.Unknown;

    /// <summary>
    /// Install history, last-install time and configured active hours are all in
    /// the agent's collector and none of them are in this server's contract. The
    /// section names the gap rather than leaving three empty fields that read as
    /// "never installed anything".
    /// </summary>
    public SectionAvailability HistoryAvailability { get; } =
        SectionAvailability.NotCarriedByServer("Update install history, last install time and active hours");

    public override void Apply(CabinetLatestDto? latest, DateTime nowUtc)
    {
        PendingUpdates.Clear();

        CheckInDetailDto? check = latest?.LatestCheckIn;

        if (check is null)
        {
            Availability = SectionAvailability.NoCheckIn;
            PendingCount = Format.NotReported;
            RebootPending = StatusPresentation.Unknown;
            SecurityPending = StatusPresentation.Unknown;
            return;
        }

        List<PendingUpdateSnapshot> updates =
            check.Payload?.PendingUpdates ?? new List<PendingUpdateSnapshot>();

        foreach (PendingUpdateRow row in updates
                     .Select(u => new PendingUpdateRow(u))
                     .OrderByDescending(u => u.Snapshot.IsSecurityUpdate)
                     .ThenBy(u => u.Title, StringComparer.CurrentCultureIgnoreCase))
        {
            PendingUpdates.Add(row);
        }

        // The projected count is what the fleet view and the server's health
        // evaluation use, so it is shown rather than the length of the payload
        // list: if the two ever disagree, the number that drives decisions
        // elsewhere is the one worth seeing here.
        PendingCount = Format.Count(check.PendingUpdateCount);

        Availability = updates.Count == 0 && check.PendingUpdateCount == 0
            ? SectionAvailability.Empty("pending updates")
            : SectionAvailability.Available;

        // Derived from the updates themselves, which is the only reboot signal
        // this contract carries. Said plainly in RebootPendingNote so nobody
        // reads it as Windows' own reboot-required flag.
        bool anyRequiresReboot = updates.Any(u => u.RequiresReboot);

        RebootPending = updates.Count == 0
            ? new StatusPresentation("No pending updates require a reboot", "✔", StatusSeverity.Good)
            : anyRequiresReboot
                ? new StatusPresentation("A pending update requires a reboot", "▲", StatusSeverity.Warning)
                : new StatusPresentation("No pending update requires a reboot", "✔", StatusSeverity.Good);

        int securityCount = updates.Count(u => u.IsSecurityUpdate);

        SecurityPending = securityCount == 0
            ? new StatusPresentation("No pending security updates", "✔", StatusSeverity.Good)
            : new StatusPresentation(
                $"{securityCount} pending security {(securityCount == 1 ? "update" : "updates")}",
                "▲", StatusSeverity.Warning);
    }

    /// <summary>
    /// Names what the reboot indicator is and is not, because the difference
    /// matters when deciding whether to schedule a disruptive reboot.
    /// </summary>
    public string RebootPendingNote =>
        "Derived from the pending updates themselves. This server's contract does not carry " +
        "Windows' own reboot-required flag, so a reboot pending from something other than an " +
        "update would not appear here.";

    public override string Summarise() =>
        Availability.HasData
            ? $"{PendingCount} pending updates. {RebootPending.Label}. {SecurityPending.Label}."
            : $"Windows Update: {Availability.Reason}";
}
