using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Services;

/// <summary>
/// The network service's half of watched services: it reads the broker's watch status every minute and turns each
/// change into a service event (docs/spec/12-milestones-8-to-12.md): restarted (minor), failing (major), recovered,
/// missing or disabled (minor). What it has reported is kept on disk, so a restart never reports the same thing twice.
/// </summary>
public sealed class ServiceWatchReporter(StateFile<ServiceWatchReporter.Seen> store, TimeProvider clock)
{
    public sealed class Seen
    {
        public Dictionary<string, Last> Services { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    public sealed class Last
    {
        public WatchState State { get; set; }
        public DateTimeOffset? LastRestartAt { get; set; }
    }

    public IReadOnlyList<AgentEvent> Observe(IReadOnlyList<WatchedServiceStatus> statuses)
    {
        var seen = store.Load();
        var events = new List<AgentEvent>();
        DateTimeOffset now = clock.GetUtcNow();
        foreach (var s in statuses)
        {
            seen.Services.TryGetValue(s.Name, out Last? before);
            if (s.State == WatchState.Waiting) continue;
            bool newRestart = s.LastRestartAt is { } at && (before?.LastRestartAt is null || at > before.LastRestartAt);
            if (s.State == WatchState.Failing && before?.State != WatchState.Failing)
                events.Add(Event(s, "failing", SeverityHint.Major, $"Watched service {s.Name} will not stay running: {s.ConsecutiveFailures} restarts in a row failed"
                    + (s.LastError is { } code ? $" (Windows error {code})." : "."), now));
            else if (before?.State == WatchState.Failing && s.State is WatchState.Running or WatchState.Restarted)
                events.Add(Event(s, "recovered", SeverityHint.Minor, $"Watched service {s.Name} is running again.", now));
            else if (newRestart && s.State != WatchState.Failing)
                events.Add(Event(s, "restarted", SeverityHint.Minor, $"Watched service {s.Name} had stopped and was started again automatically.", now));
            if (s.State is WatchState.Missing or WatchState.Disabled && before?.State != s.State)
                events.Add(Event(s, s.State == WatchState.Missing ? "missing" : "disabled", SeverityHint.Minor,
                    s.State == WatchState.Missing ? $"Watched service {s.Name} does not exist on this cabinet." : $"Watched service {s.Name} is disabled, so it is not started.", now));
            seen.Services[s.Name] = new Last { State = s.State, LastRestartAt = s.LastRestartAt ?? before?.LastRestartAt };
        }
        foreach (string gone in seen.Services.Keys.Where(k => !statuses.Any(s => string.Equals(s.Name, k, StringComparison.OrdinalIgnoreCase))).ToList())
            seen.Services.Remove(gone);
        store.Save(seen);
        return events;
    }

    private static AgentEvent Event(WatchedServiceStatus s, string change, SeverityHint severity, string message, DateTimeOffset now)
    {
        var fields = new Dictionary<string, string> { ["service"] = s.Name, ["change"] = change, ["restartsToday"] = s.RestartsToday.ToString() };
        if (s.LastError is { } code) fields["errorCode"] = code.ToString();
        return new AgentEvent
        {
            EventId = EventIds.For($"service|{s.Name}|{change}|{s.LastRestartAt:O}|{s.ConsecutiveFailures}|{now:yyyy-MM-ddTHH:mm}"),
            Kind = EventKind.Service, OccurredAt = now, SeverityHint = severity,
            Detail = new EventDetail { Message = message, Fields = fields },
        };
    }
}
