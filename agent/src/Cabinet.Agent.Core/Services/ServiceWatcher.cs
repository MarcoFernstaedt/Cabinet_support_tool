using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Services;

/// <summary>
/// Keeps the watched services running (docs/spec/12-milestones-8-to-12.md, milestone 10). It runs in the broker, which
/// has the rights to start services. Every check: a stopped service is started again. A failed restart is a start
/// Windows refuses, or a service that stops again within 2 minutes of being started. After 3 in a row the watcher
/// waits 15 minutes before trying again; 10 minutes of running resets the count. It never starts a disabled or refused
/// service, and never changes a start type. Its state survives restarts.
///
/// A watched service must also be on the cabinet's approved list, checked against the program its registered path points
/// at now, the same check service.control makes. A watched service that is not approved is reported as refused and is
/// never started: watching it is not a way round the list.
/// </summary>
public sealed class ServiceWatcher(IServicePlatform platform, StateFile<ServiceWatcher.Saved> store, TimeProvider clock, Action<string> log)
{
    public static readonly TimeSpan CheckEvery = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan StopsTooSoon = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan ResetAfter = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan Backoff = TimeSpan.FromMinutes(15);
    public const int FailuresBeforeAlert = 3;

    public sealed class Record
    {
        public int ConsecutiveFailures { get; set; }
        public int RestartsToday { get; set; }
        public string? Day { get; set; }
        public DateTimeOffset? LastRestartAt { get; set; }
        public DateTimeOffset? LastStartedAt { get; set; }
        public DateTimeOffset? BackoffUntil { get; set; }
        public long? LastError { get; set; }
        public WatchState State { get; set; } = WatchState.Waiting;
        public ServiceState? ServiceState { get; set; }
        public DateTimeOffset? CheckedAt { get; set; }
    }

    public sealed class Saved
    {
        public List<string> Names { get; set; } = [];
        public Dictionary<string, Record> Records { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private readonly object _gate = new();

    /// <summary>The approved list in force, read again at every check; left unset, nothing is approved and nothing is started.</summary>
    public Func<ApprovedApps> Approved { get; set; } = static () => ApprovedApps.None;

    /// <summary>Replaces the list (from the console, through the network service). Names are checked again here.</summary>
    public void SetList(IReadOnlyList<string> names)
    {
        lock (_gate)
        {
            var s = store.Load();
            var clean = names.Where(ServiceRules.IsValidName).Distinct(StringComparer.OrdinalIgnoreCase).Take(16).ToList();
            if (clean.SequenceEqual(s.Names, StringComparer.OrdinalIgnoreCase)) return;
            s.Names = clean;
            foreach (string gone in s.Records.Keys.Where(k => !clean.Contains(k, StringComparer.OrdinalIgnoreCase)).ToList()) s.Records.Remove(gone);
            store.Save(s);
            log($"Watching {clean.Count} services: {string.Join(", ", clean)}.");
        }
    }

    public IReadOnlyList<WatchedServiceStatus> Status()
    {
        lock (_gate)
        {
            var s = store.Load();
            return s.Names.Select(n => s.Records.TryGetValue(n, out var r) ? View(n, r) : View(n, new Record())).ToList();
        }
    }

    /// <summary>One look at every watched service; called every 30 seconds by the broker.</summary>
    public void Tick()
    {
        lock (_gate)
        {
            var s = store.Load();
            DateTimeOffset now = clock.GetUtcNow();
            foreach (string name in s.Names)
            {
                if (!s.Records.TryGetValue(name, out var r)) s.Records[name] = r = new Record();
                Check(name, r, now);
            }
            store.Save(s);
        }
    }

    private void Check(string name, Record r, DateTimeOffset now)
    {
        string today = now.UtcDateTime.ToString("yyyy-MM-dd");
        if (r.Day != today) { r.Day = today; r.RestartsToday = 0; }
        r.CheckedAt = now;
        if (ServiceRules.IsRefused(name)) { r.State = WatchState.Refused; r.ServiceState = null; return; }
        // Only an exact key name is watched: a display name ("Remote Desktop Services") is treated as missing.
        string? key = platform.KeyName(name);
        if (key is null) { r.State = WatchState.Missing; r.ServiceState = null; return; }
        if (ServiceRules.IsRefused(key)) { r.State = WatchState.Refused; r.ServiceState = null; return; }
        var facts = platform.Query(key);
        if (facts is null) { r.State = WatchState.Missing; r.ServiceState = null; return; }
        r.ServiceState = facts.Value.State;
        if (facts.Value.StartType == ServiceStartType.Disabled) { r.State = WatchState.Disabled; return; }
        if (!IsApproved(key))
        {
            if (r.State != WatchState.Refused) log($"Watched service {name} is not on this cabinet's approved list (or no longer runs the program it names); it is reported, never started.");
            r.State = WatchState.Refused;
            return;
        }

        switch (facts.Value.State)
        {
            case ServiceState.Running:
                if (r.LastStartedAt is { } started && now - started >= ResetAfter) { r.ConsecutiveFailures = 0; r.BackoffUntil = null; r.LastStartedAt = null; }
                r.State = r.ConsecutiveFailures >= FailuresBeforeAlert ? WatchState.Failing
                    : r.LastRestartAt is { } at && now - at < ResetAfter ? WatchState.Restarted : WatchState.Running;
                return;
            case ServiceState.Stopped:
                break;
            default:
                return; // starting, stopping or paused: look again next time
        }

        // Stopped again soon after the watcher started it: that start did not hold.
        if (r.LastStartedAt is { } last && now - last < StopsTooSoon) { r.ConsecutiveFailures++; r.LastStartedAt = null; }
        if (r.ConsecutiveFailures >= FailuresBeforeAlert)
        {
            r.State = WatchState.Failing;
            if (r.BackoffUntil is null) { r.BackoffUntil = now + Backoff; log($"Watched service {name} failed {r.ConsecutiveFailures} restarts in a row; trying again at {r.BackoffUntil:u}."); return; }
            if (now < r.BackoffUntil) return;
            r.BackoffUntil = now + Backoff; // one more try now, then wait again if it fails
        }
        try
        {
            platform.Start(key);
            r.RestartsToday++;
            r.LastRestartAt = now;
            r.LastStartedAt = now;
            r.LastError = null;
            if (r.State != WatchState.Failing) r.State = WatchState.Restarted;
            log($"Watched service {name} was stopped; started it again.");
        }
        catch (ServiceControlException e)
        {
            r.ConsecutiveFailures++;
            r.LastError = e.Code;
            r.State = r.ConsecutiveFailures >= FailuresBeforeAlert ? WatchState.Failing : WatchState.Restarted;
            if (r.ConsecutiveFailures >= FailuresBeforeAlert && r.BackoffUntil is null) r.BackoffUntil = now + Backoff;
            log($"Watched service {name} would not start (Windows error {e.Code}); failure {r.ConsecutiveFailures} in a row.");
        }
    }

    private bool IsApproved(string key)
    {
        try
        {
            Approved().RefuseServiceControl(key, ServiceRules.RegisteredProgram(platform, key, log));
            return true;
        }
        catch (OperationFailedException) { return false; }
    }

    private static WatchedServiceStatus View(string name, Record r) => new()
    {
        Name = name, State = r.State, ServiceState = r.ServiceState, RestartsToday = r.RestartsToday, ConsecutiveFailures = r.ConsecutiveFailures,
        LastRestartAt = r.LastRestartAt, LastError = r.LastError, CheckedAt = r.CheckedAt,
    };
}
