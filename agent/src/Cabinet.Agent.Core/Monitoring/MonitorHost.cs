using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>Where the monitors read from. Each source is optional; a missing one turns that monitor off.</summary>
public sealed class MonitorSources
{
    public Func<CancellationToken, Task<IReadOnlyList<DeviceFacts>>>? Devices { get; init; }
    public Func<CancellationToken, Task<DiskSmartOutput>>? Drives { get; init; }
    public Func<CancellationToken, Task<FirewallStateOutput>>? Firewall { get; init; }
    /// <summary>The allowed logs present on this cabinet.</summary>
    public Func<CancellationToken, Task<IReadOnlyList<string>>>? Logs { get; init; }
    public Func<EventlogQueryParams, CancellationToken, Task<EventlogQueryOutput>>? Query { get; init; }
    /// <summary>The platform command whose change left the firewall with this fingerprint (from the broker's journal).</summary>
    public Func<string, Guid?>? PlatformFirewallChange { get; init; }
    /// <summary>
    /// The broker's service watcher: hands it the list of services to keep running (null: only asks) and returns their status.
    /// The broker does the restarting; this side only reports what changed.
    /// </summary>
    public Func<IReadOnlyList<string>?, CancellationToken, Task<IReadOnlyList<WatchedServiceStatus>>>? Watch { get; init; }
}

public sealed class MonitorIntervals
{
    public TimeSpan Scanner { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan EventLogs { get; init; } = TimeSpan.FromMinutes(2);
    public TimeSpan FirstEventLogLook { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan FirewallLog { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan FirewallFull { get; init; } = TimeSpan.FromMinutes(5);
    public TimeSpan Drives { get; init; } = TimeSpan.FromDays(1);
    public TimeSpan FirstDriveCheck { get; init; } = TimeSpan.FromMinutes(10);
    public TimeSpan WatchedServices { get; init; } = TimeSpan.FromSeconds(60);
}

/// <summary>
/// Runs the background monitors (docs/spec/04-agent-spec.md) and puts what they find
/// in the event queue. Monitors only read: none of them can change the cabinet, and
/// none takes instructions from the server beyond the data in <see cref="MonitorSettings"/>.
/// </summary>
public sealed class MonitorHost(MonitorSources sources, MonitorSettings settings, EventQueue queue, string? stateDir, TimeProvider clock,
    Action<string> log, MonitorIntervals? intervals = null)
{
    private readonly MonitorIntervals _every = intervals ?? new MonitorIntervals();
    private readonly ScannerWatch _scanner = new();
    private readonly SemaphoreSlim _firewallNow = new(0, 1);

    private volatile FirewallProfileSwitches? _firewallProfiles;

    /// <summary>Each firewall profile on or off as the watcher last saw it; null until it has looked once. Sent with every heartbeat.</summary>
    public FirewallProfileSwitches? FirewallProfiles => _firewallProfiles;

    /// <summary>Looks at the firewall now instead of waiting (after a platform change, so it is attributed promptly).</summary>
    public void FirewallNow()
    {
        try { if (_firewallNow.CurrentCount == 0) _firewallNow.Release(); } catch (SemaphoreFullException) { }
    }

    private string? State(string name) => stateDir is null ? null : Path.Combine(stateDir, name);

    public Task RunAsync(CancellationToken token)
    {
        var loops = new List<Task>();
        if (sources.Devices is not null) loops.Add(Loop("scanner", _every.Scanner, TimeSpan.Zero, ScannerOnceAsync, token));
        if (sources.Logs is not null && sources.Query is not null)
        {
            var watch = new EventLogWatch(new StateFile<EventLogWatch.State>(State("eventlog-bookmarks.json")), sources.Query);
            loops.Add(Loop("event logs", _every.EventLogs, _every.FirstEventLogLook, t => EventLogsOnceAsync(watch, t), token));
        }
        if (sources.Firewall is not null)
        {
            var watch = new FirewallWatch(new StateFile<FirewallWatch.State>(State("firewall-state.json")), sources.PlatformFirewallChange);
            loops.Add(FirewallLoopAsync(watch, token));
            if (sources.Query is not null)
            {
                var changes = new EventLogWatchForIds(new StateFile<EventLogWatch.State>(State("firewall-log-bookmark.json")), sources.Query);
                loops.Add(Loop("firewall log", _every.FirewallLog, TimeSpan.FromSeconds(20), async t =>
                {
                    if (await changes.AnyNewAsync(FirewallWatch.FirewallLog, FirewallWatch.ChangeEventIds, clock.GetUtcNow(), t).ConfigureAwait(false))
                        _firewallNow.Release();
                }, token));
            }
        }
        if (sources.Drives is not null)
        {
            var watch = new DriveWatch(new StateFile<DriveWatch.State>(State("drive-health.json")));
            loops.Add(Loop("drive health", _every.Drives, _every.FirstDriveCheck, async t =>
            {
                foreach (var e in watch.Check(await sources.Drives(t).ConfigureAwait(false), clock.GetUtcNow())) Add(e);
            }, token));
        }
        if (sources.Watch is not null)
        {
            var reporter = new Services.ServiceWatchReporter(new StateFile<Services.ServiceWatchReporter.Seen>(State("service-watch-reported.json")), clock);
            loops.Add(Loop("watched services", _every.WatchedServices, TimeSpan.FromSeconds(5), t => WatchedServicesOnceAsync(reporter, t), token));
        }
        settings.Changed += () => log("New scanner hardware IDs from the console; the scanner watcher uses them from its next look.");
        return Task.WhenAll(loops);
    }

    private IReadOnlyList<string>? _watchSent;

    /// <summary>
    /// Hands the broker the watch list when it changed (and every look while the broker has not confirmed it), then turns
    /// what the broker reports into service events.
    /// </summary>
    public async Task WatchedServicesOnceAsync(Services.ServiceWatchReporter reporter, CancellationToken token)
    {
        IReadOnlyList<string> wanted = settings.WatchedServices;
        bool send = _watchSent is null || !_watchSent.SequenceEqual(wanted, StringComparer.OrdinalIgnoreCase);
        var statuses = await sources.Watch!(send ? wanted : null, token).ConfigureAwait(false);
        if (send) _watchSent = wanted;
        foreach (var e in reporter.Observe(statuses))
        {
            log($"Watched service {e.Detail!.Fields!["service"]}: {e.Detail.Fields["change"]}.");
            Add(e);
        }
    }

    /// <summary>One look at the scanner, for tests and the harness.</summary>
    public async Task ScannerOnceAsync(CancellationToken token)
    {
        var devices = await sources.Devices!(token).ConfigureAwait(false);
        if (_scanner.Observe(settings.ScannerHardwareIds, devices, clock.GetUtcNow()) is { } e)
        {
            log($"Fingerprint scanner: {e.Device!.State.ToString().ToLowerInvariant()}.");
            Add(e);
        }
    }

    private async Task EventLogsOnceAsync(EventLogWatch watch, CancellationToken token)
    {
        foreach (string name in await sources.Logs!(token).ConfigureAwait(false))
        {
            try { foreach (var e in await watch.CheckAsync(name, clock.GetUtcNow(), token).ConfigureAwait(false)) Add(e); }
            catch (OperationFailedException) { } // a log that cannot be read now is tried again next time
        }
    }

    private async Task FirewallLoopAsync(FirewallWatch watch, CancellationToken token)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(10), clock, token).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
        while (!token.IsCancellationRequested)
        {
            try
            {
                FirewallStateOutput state = await sources.Firewall!(token).ConfigureAwait(false);
                _firewallProfiles = new FirewallProfileSwitches
                {
                    Domain = state.Profiles.Any(p => p.Profile == FirewallProfile.Domain && p.Enabled),
                    Private = state.Profiles.Any(p => p.Profile == FirewallProfile.Private && p.Enabled),
                    Public = state.Profiles.Any(p => p.Profile == FirewallProfile.Public && p.Enabled),
                };
                if (watch.Check(state, clock.GetUtcNow()) is { } e)
                {
                    log(e.CommandId is { } cmd ? $"The firewall configuration changed through the platform (command {cmd})." : "The firewall configuration changed outside the platform.");
                    Add(e);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception e) { log($"Monitor firewall: {e.GetType().Name}: {OperationRunner.Truncate(e.Message)}"); }
            try { await _firewallNow.WaitAsync(_every.FirewallFull, token).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
        }
    }

    private void Add(AgentEvent e)
    {
        if (!queue.Enqueue(e) && e.Kind != EventKind.Error) log($"A {e.Kind} event did not match its contract and was not queued.");
    }

    private async Task Loop(string name, TimeSpan every, TimeSpan first, Func<CancellationToken, Task> once, CancellationToken token)
    {
        try { await Task.Delay(first, clock, token).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
        bool failing = false;
        while (!token.IsCancellationRequested)
        {
            try
            {
                await once(token).ConfigureAwait(false);
                failing = false;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception e)
            {
                // A monitor that fails keeps trying; it is reported once, not on every attempt.
                if (!failing) log($"Monitor {name}: {e.GetType().Name}: {OperationRunner.Truncate(e.Message)}");
                failing = true;
            }
            try { await Task.Delay(every, clock, token).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
        }
    }
}

/// <summary>Whether a log has new entries with given event IDs since the last look (any level).</summary>
public sealed class EventLogWatchForIds(StateFile<EventLogWatch.State> store, Func<EventlogQueryParams, CancellationToken, Task<EventlogQueryOutput>> query)
{
    public async Task<bool> AnyNewAsync(string log, IReadOnlyList<int> ids, DateTimeOffset now, CancellationToken token)
    {
        var state = store.Load();
        state.Logs.TryGetValue(log, out var mark);
        var output = await query(new EventlogQueryParams
        {
            Log = log, EventIds = ids, From = mark is null ? now : mark.Time - TimeSpan.FromMinutes(5), PageSize = 20,
        }, token).ConfigureAwait(false);
        var newer = output.Entries.Where(e => mark is null || e.RecordId > mark.RecordId).ToList();
        if (newer.Count > 0 || mark is null)
        {
            state.Logs[log] = newer.Count > 0
                ? new EventLogWatch.Bookmark { RecordId = newer.Max(e => e.RecordId), Time = newer.Max(e => e.Time) }
                : new EventLogWatch.Bookmark { RecordId = 0, Time = now };
            store.Save(state);
        }
        return newer.Count > 0 && mark is not null;
    }
}
