using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.Rows;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// Volumes, drive health and SMART counters, plus the trend of those counters
/// over time.
/// </summary>
/// <remarks>
/// No actions. Nothing this console can do to a failing drive is safe to do
/// remotely, and offering a button that implies otherwise would be worse than
/// offering none.
/// </remarks>
public sealed partial class DiskSectionViewModel : MachineSectionViewModel
{
    public DiskSectionViewModel()
        : base("Disk",
            "Per-drive free space, health status, SMART counters, and the trend of " +
            "those counters over time. This section has no actions.")
    {
    }

    public ObservableCollection<VolumeRow> Volumes { get; } = new();

    /// <summary>The newest SMART reading per drive.</summary>
    public ObservableCollection<SmartRow> Drives { get; } = new();

    /// <summary>
    /// SMART readings over the selected window for the selected drive.
    /// </summary>
    /// <remarks>
    /// Presented as a table as well as a chart. A trend line with no tabular
    /// equivalent is a picture, and a picture is not data to anyone using a
    /// screen reader — nor to anyone who needs to quote a figure into a ticket.
    /// </remarks>
    public ObservableCollection<SmartRow> History { get; } = new();

    [ObservableProperty]
    private SmartRow? _selectedDrive;

    [ObservableProperty]
    private SectionAvailability _historyAvailability = SectionAvailability.NoCheckIn;

    [ObservableProperty]
    private bool _isHistoryLoading;

    /// <summary>How far back the trend view reaches. Bounded by the server.</summary>
    [ObservableProperty]
    private int _historyDays = 7;

    /// <summary>
    /// Windows the trend view offers. All inside the server's 90-day maximum,
    /// so no choice here can produce a request the server will refuse.
    /// </summary>
    public IReadOnlyList<int> HistoryDayChoices { get; } = new[] { 1, 7, 30, 90 };

    [ObservableProperty]
    private SectionAvailability _volumesAvailability = SectionAvailability.NoCheckIn;

    [ObservableProperty]
    private SectionAvailability _smartAvailability = SectionAvailability.NoCheckIn;

    /// <summary>
    /// Raised when the drive or the window changes, so the owning tab can fetch
    /// the trend. The section does not call the API itself — it has no client,
    /// and giving it one would put a second HTTP caller in the console.
    /// </summary>
    public event EventHandler? HistoryRequested;

    partial void OnSelectedDriveChanged(SmartRow? value) =>
        HistoryRequested?.Invoke(this, EventArgs.Empty);

    partial void OnHistoryDaysChanged(int value) =>
        HistoryRequested?.Invoke(this, EventArgs.Empty);

    /// <summary>
    /// The counters worth trending, as an accessible table beside the chart.
    /// Only counters the selected drive actually reports appear: an NVMe module
    /// has no reallocated-sector count, and an empty column implying otherwise
    /// would be a reading invented by the layout.
    /// </summary>
    public IReadOnlyList<SmartTrendSeries> TrendSeries { get; private set; } =
        Array.Empty<SmartTrendSeries>();

    public override void Apply(CabinetLatestDto? latest, DateTime nowUtc)
    {
        Volumes.Clear();
        Drives.Clear();

        CheckInDetailDto? check = latest?.LatestCheckIn;

        if (latest is null || check is null)
        {
            Availability = SectionAvailability.NoCheckIn;
            VolumesAvailability = SectionAvailability.NoCheckIn;
            SmartAvailability = SectionAvailability.NoCheckIn;
            SelectedDrive = null;
            return;
        }

        Availability = SectionAvailability.Available;

        foreach (VolumeRow row in (check.Payload?.Volumes ?? new()).Select(v => new VolumeRow(v)))
        {
            Volumes.Add(row);
        }

        VolumesAvailability = Volumes.Count == 0
            ? SectionAvailability.Empty("disk volumes")
            : SectionAvailability.Available;

        foreach (SmartRow row in latest.LatestSmartReadings
                     .Select(s => new SmartRow(s))
                     .OrderBy(s => s.DriveSerial, StringComparer.OrdinalIgnoreCase))
        {
            Drives.Add(row);
        }

        SmartAvailability = Drives.Count == 0
            ? SectionAvailability.Empty("SMART readings")
            : SectionAvailability.Available;

        // Selecting the first drive means the trend view has something in it
        // when the section opens, rather than an empty panel and an
        // instruction.
        SelectedDrive = Drives.FirstOrDefault();
    }

    /// <summary>Replaces the trend with readings fetched by the owning tab.</summary>
    public void ApplyHistory(IReadOnlyList<SmartRow> readings)
    {
        History.Clear();

        foreach (SmartRow row in readings.OrderBy(r => r.TimestampUtc))
        {
            History.Add(row);
        }

        HistoryAvailability = History.Count == 0
            ? SectionAvailability.Empty($"SMART readings in the last {HistoryDays} days")
            : SectionAvailability.Available;

        TrendSeries = BuildSeries(History);
        OnPropertyChanged(nameof(TrendSeries));
    }

    public void FailHistory(string reason)
    {
        History.Clear();
        TrendSeries = Array.Empty<SmartTrendSeries>();
        HistoryAvailability = SectionAvailability.Failed(reason);
        OnPropertyChanged(nameof(TrendSeries));
    }

    /// <summary>
    /// Builds one series per counter the drive reports at least once. A counter
    /// absent from every reading is left out rather than drawn flat at zero.
    /// </summary>
    private static IReadOnlyList<SmartTrendSeries> BuildSeries(IEnumerable<SmartRow> rows)
    {
        List<SmartRow> readings = rows.ToList();

        if (readings.Count == 0)
        {
            return Array.Empty<SmartTrendSeries>();
        }

        (string Name, Func<SmartRow, double?> Selector)[] candidates =
        {
            ("Reallocated sectors", r => r.Reading.ReallocatedSectorCount),
            ("Pending sectors", r => r.Reading.CurrentPendingSectorCount),
            ("Offline uncorrectable", r => r.Reading.OfflineUncorrectableCount),
            ("Reported uncorrectable", r => r.Reading.ReportedUncorrectableErrors),
            ("Command timeouts", r => r.Reading.CommandTimeoutCount),
            ("CRC errors", r => r.Reading.UdmaCrcErrorCount),
            ("Percentage used", r => r.Reading.PercentageUsed),
            ("Available spare %", r => r.Reading.AvailableSparePercent),
            ("Media and data integrity errors", r => r.Reading.MediaAndDataIntegrityErrors),
            ("Unsafe shutdowns", r => r.Reading.UnsafeShutdownCount),
            ("Temperature °C", r => r.Reading.TemperatureCelsius),
            ("Power-on hours", r => r.Reading.PowerOnHours)
        };

        List<SmartTrendSeries> series = new();

        foreach ((string name, Func<SmartRow, double?> selector) in candidates)
        {
            List<SmartTrendPoint> points = readings
                .Select(r => new SmartTrendPoint(r.Reading.TimestampUtc, selector(r), r.IsAggregated))
                .ToList();

            if (points.All(p => p.Value is null))
            {
                continue;
            }

            series.Add(new SmartTrendSeries(name, points));
        }

        return series;
    }

    public override string Summarise() =>
        Availability.HasData
            ? $"{Volumes.Count} volumes, {Drives.Count} drives with SMART data."
            : $"Disk: {Availability.Reason}";
}

/// <summary>One counter's value at one moment, or null where it was not reported.</summary>
public sealed record SmartTrendPoint(DateTime TimestampUtc, double? Value, bool IsAggregated)
{
    public string Timestamp => Format.LocalTime(TimestampUtc);

    public string Display => Value is null
        ? Format.NotReported
        : Value.Value.ToString("0.##", System.Globalization.CultureInfo.CurrentCulture);

    public string Resolution => IsAggregated ? "Daily average" : "As sampled";
}

/// <summary>
/// One trended counter. Carries its own range so a chart and the table beside
/// it cannot disagree about what they are showing.
/// </summary>
public sealed class SmartTrendSeries
{
    public SmartTrendSeries(string name, IReadOnlyList<SmartTrendPoint> points)
    {
        Name = name;
        Points = points;

        List<double> values = points.Where(p => p.Value is not null).Select(p => p.Value!.Value).ToList();

        Minimum = values.Count == 0 ? null : values.Min();
        Maximum = values.Count == 0 ? null : values.Max();
        First = values.Count == 0 ? null : values[0];
        Last = values.Count == 0 ? null : values[^1];
    }

    public string Name { get; }
    public IReadOnlyList<SmartTrendPoint> Points { get; }

    public double? Minimum { get; }
    public double? Maximum { get; }
    public double? First { get; }
    public double? Last { get; }

    /// <summary>
    /// Which way the counter moved across the window, in words.
    /// </summary>
    /// <remarks>
    /// This is the sentence that makes the trend usable without seeing the
    /// chart, and it is the honest reading of the data: a rising reallocated
    /// sector count is the signal that a drive is going, and "rose from 0 to 24"
    /// says that in a way a sparkline does not.
    /// </remarks>
    public string Direction
    {
        get
        {
            if (First is not { } first || Last is not { } last)
            {
                return "Not reported over this window.";
            }

            string range = $"from {first:0.##} to {last:0.##}";

            return last switch
            {
                _ when last > first => $"Rising, {range}.",
                _ when last < first => $"Falling, {range}.",
                _ => $"Unchanged at {last:0.##}."
            };
        }
    }

    public string AccessibleSummary =>
        $"{Name}. {Points.Count} readings. {Direction}";
}
