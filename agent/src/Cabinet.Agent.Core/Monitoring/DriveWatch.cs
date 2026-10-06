using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// The daily drive health check. Warns early, so a client gets a new drive before
/// the old one fails: on the drive's own failure prediction, a Windows health
/// warning, any reallocated, pending or uncorrectable sectors, heavy wear or heat.
/// Once a drive has been reported, it is reported again only when it gets worse.
/// </summary>
public sealed class DriveWatch(StateFile<DriveWatch.State> store)
{
    public const int WearWarnPercent = 80;
    public const int HotCelsius = 60;

    public sealed class State
    {
        public Dictionary<string, Reading> Drives { get; set; } = new();
    }

    public sealed class Reading
    {
        public List<string> Reasons { get; set; } = new();
        public long Reallocated { get; set; }
        public long Pending { get; set; }
        public long Uncorrectable { get; set; }
        public int Wear { get; set; }
    }

    /// <summary>What is wrong with a drive now, in plain words; empty when nothing is.</summary>
    public static List<string> Reasons(DriveSmart d)
    {
        var reasons = new List<string>();
        if (d.PredictFailure == true) reasons.Add("predicts_failure");
        if (d.Health == DriveHealth.Failing) reasons.Add("health_failing");
        else if (d.Health == DriveHealth.Warning) reasons.Add("health_warning");
        if (d.ReallocatedSectors > 0) reasons.Add("reallocated_sectors");
        if (d.PendingSectors > 0) reasons.Add("pending_sectors");
        if (d.UncorrectableErrors > 0) reasons.Add("uncorrectable_errors");
        if (d.WearPercent >= WearWarnPercent) reasons.Add("wear");
        if (d.TemperatureCelsius >= HotCelsius) reasons.Add("temperature");
        return reasons;
    }

    public IReadOnlyList<AgentEvent> Check(DiskSmartOutput output, DateTimeOffset now)
    {
        State state = store.Load();
        var events = new List<AgentEvent>();
        var seen = new Dictionary<string, Reading>();
        for (int i = 0; i < output.Drives.Count; i++)
        {
            DriveSmart d = output.Drives[i];
            string key = d.SerialNumber ?? d.Model ?? $"drive{i}";
            var reading = new Reading
            {
                Reasons = Reasons(d), Reallocated = d.ReallocatedSectors ?? 0, Pending = d.PendingSectors ?? 0,
                Uncorrectable = d.UncorrectableErrors ?? 0, Wear = d.WearPercent ?? 0,
            };
            state.Drives.TryGetValue(key, out Reading? last);
            if (reading.Reasons.Count > 0 && Worse(reading, last))
                events.Add(Build(d, reading, last, now));
            // Remember the worst seen, so a counter that dips and returns is not reported twice.
            seen[key] = last is null || reading.Reasons.Count == 0 ? reading : Merge(reading, last);
        }
        state.Drives = seen;
        store.Save(state);
        return events;
    }

    private static bool Worse(Reading now, Reading? last) =>
        last is null || now.Reasons.Except(last.Reasons).Any() || now.Reallocated > last.Reallocated || now.Pending > last.Pending ||
        now.Uncorrectable > last.Uncorrectable || now.Wear >= last.Wear + 5;

    private static Reading Merge(Reading now, Reading last) => new()
    {
        Reasons = now.Reasons.Union(last.Reasons).ToList(), Reallocated = Math.Max(now.Reallocated, last.Reallocated),
        Pending = Math.Max(now.Pending, last.Pending), Uncorrectable = Math.Max(now.Uncorrectable, last.Uncorrectable), Wear = Math.Max(now.Wear, last.Wear),
    };

    private static AgentEvent Build(DriveSmart d, Reading r, Reading? last, DateTimeOffset now)
    {
        bool urgent = r.Reasons.Intersect(new[] { "predicts_failure", "health_failing", "uncorrectable_errors", "pending_sectors" }).Any();
        string name = d.Model ?? "A drive";
        string message = urgent
            ? $"{name} shows signs of failing. Plan a replacement drive now and make sure backups are current."
            : $"{name} shows early wear. Plan a replacement drive before it fails.";
        var fields = new Dictionary<string, string> { ["reasons"] = string.Join(',', r.Reasons) };
        void Add(string k, object? v) { if (v is not null) fields[k] = EventText.ShortText(v.ToString()); }
        Add("model", d.Model);
        Add("serialNumber", d.SerialNumber);
        Add("health", d.Health.ToString().ToLowerInvariant());
        Add("reallocatedSectors", d.ReallocatedSectors);
        Add("pendingSectors", d.PendingSectors);
        Add("uncorrectableErrors", d.UncorrectableErrors);
        Add("wearPercent", d.WearPercent);
        Add("temperatureCelsius", d.TemperatureCelsius);
        Add("powerOnHours", d.PowerOnHours);
        if (last is not null) fields["worsened"] = "true";
        return new AgentEvent
        {
            EventId = Guid.NewGuid(),
            Kind = EventKind.SmartWarning,
            OccurredAt = now,
            SeverityHint = urgent ? SeverityHint.Major : SeverityHint.Minor,
            Detail = new EventDetail { Message = message, Fields = fields },
        };
    }
}
