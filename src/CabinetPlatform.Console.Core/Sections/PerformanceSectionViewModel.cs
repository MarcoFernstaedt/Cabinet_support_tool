using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// CPU and memory as of the last check-in.
/// </summary>
/// <remarks>
/// The brief asks for a process list sortable by CPU and memory. The agent
/// collects one; this server's <c>CheckInRequest</c> has no field for it, so
/// there is nothing to sort. The section says so in
/// <see cref="ProcessListAvailability"/> instead of showing an empty grid that
/// would read as "no processes running".
/// </remarks>
public sealed partial class PerformanceSectionViewModel : MachineSectionViewModel
{
    public PerformanceSectionViewModel()
        : base("Performance", "Processor and memory utilisation from the last check-in.")
    {
    }

    [ObservableProperty] private string _cpuPercent = Format.NotReported;
    [ObservableProperty] private string _ramUsedPercent = Format.NotReported;
    [ObservableProperty] private string _ramTotal = Format.NotReported;
    [ObservableProperty] private string _ramUsed = Format.NotReported;

    [ObservableProperty]
    private StatusPresentation _cpuState = StatusPresentation.Unknown;

    [ObservableProperty]
    private StatusPresentation _ramState = StatusPresentation.Unknown;

    /// <summary>
    /// Why there is no process grid. A named gap in the platform, not a cabinet
    /// with nothing running on it.
    /// </summary>
    public SectionAvailability ProcessListAvailability { get; } =
        SectionAvailability.OnDemandOnly("The per-process list", "View process list");

    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        HeartbeatDto? check = latest?.LatestHeartbeat;

        if (check is null)
        {
            Availability = SectionAvailability.NoCheckIn;
            CpuPercent = RamUsedPercent = RamTotal = RamUsed = Format.NotReported;
            CpuState = RamState = StatusPresentation.Unknown;
            return;
        }

        Availability = SectionAvailability.Available;

        CpuPercent = Format.Percent(check.CpuPercent);
        RamUsedPercent = Format.Percent(check.RamUsedPercent);

        CpuState = Pressure(check.CpuPercent, "Processor");
        RamState = Pressure(check.RamUsedPercent, "Memory");

        // Installed memory is configuration and arrives on the inventory tier,
        // not on every heartbeat. A cabinet that has heartbeated but not yet
        // sent an inventory therefore shows live utilisation and no total,
        // which is the truth about what the server knows.
        long? totalBytes = latest?.CurrentInventory?.InstalledMemoryBytes;

        // A zero total is a failed reading, not a machine with no memory.
        RamTotal = totalBytes is > 0 ? Format.Bytes(totalBytes) : Format.NotReported;
        RamUsed = totalBytes is > 0 && check.RamUsedPercent is { } used
            ? Format.Bytes((long)(totalBytes.Value * used / 100d))
            : Format.NotReported;
    }

    /// <summary>
    /// Words for a utilisation figure. A counter that was not read has no
    /// pressure to describe and reads as unknown, never as idle.
    /// </summary>
    private static StatusPresentation Pressure(double? value, string what) => value switch
    {
        null => StatusPresentation.Unknown,
        _ => PressureOf(value.Value, what),
    };

    private static StatusPresentation PressureOf(double value, string what) => value switch
    {
        >= 95d => new StatusPresentation($"{what} saturated", "✖", StatusSeverity.Critical),
        >= 85d => new StatusPresentation($"{what} under pressure", "▲", StatusSeverity.Warning),
        < 0d => StatusPresentation.Unknown,
        _ => new StatusPresentation($"{what} normal", "✔", StatusSeverity.Good)
    };

    public override string Summarise() =>
        Availability.HasData
            ? $"Processor {CpuPercent}, memory {RamUsedPercent} of {RamTotal}."
            : $"Performance: {Availability.Reason}";
}
