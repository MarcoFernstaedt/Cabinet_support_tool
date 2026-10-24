using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Writes;

/// <summary>
/// The firewall snapshots the agent saves before every change (the last 20 are kept), the
/// timers that turn a profile back on, and the journal of changes the platform made.
/// All live in the broker's own folder; the network process may read them, never write them.
/// </summary>
public sealed class FirewallStore
{
    public const int KeepSnapshots = 20;
    private readonly string _dir;
    private readonly StateFile<Index> _index;
    private readonly StateFile<Timers> _timers;
    private readonly StateFile<Journal> _journal;
    private readonly object _gate = new();

    public sealed class Index { public List<FirewallSnapshotInfo> Snapshots { get; set; } = new(); }

    public sealed class Timer
    {
        public FirewallProfile Profile { get; set; }
        public DateTimeOffset ReenableAt { get; set; }
        public Guid CommandId { get; set; }
    }

    public sealed class Timers { public List<Timer> Items { get; set; } = new(); }

    /// <summary>A change the platform made, known by the firewall's fingerprint just after it.</summary>
    public sealed class JournalEntry
    {
        public Guid CommandId { get; set; }
        public string AfterHash { get; set; } = "";
        public DateTimeOffset At { get; set; }
    }

    public sealed class Journal { public List<JournalEntry> Items { get; set; } = new(); }

    /// <param name="dir">The broker's firewall folder; null keeps everything in memory (tests).</param>
    public FirewallStore(string? dir)
    {
        _dir = dir ?? Path.Combine(Path.GetTempPath(), "cabinet-firewall-" + Guid.NewGuid().ToString("N"));
        // The network process opens the broker's folder read-only; only the broker creates it.
        try { Directory.CreateDirectory(_dir); } catch (Exception e) when (e is UnauthorizedAccessException or IOException) { }
        _index = new StateFile<Index>(dir is null ? null : Path.Combine(dir, "snapshots.json"));
        _timers = new StateFile<Timers>(dir is null ? null : Path.Combine(dir, "timers.json"));
        _journal = new StateFile<Journal>(dir is null ? null : Path.Combine(dir, "journal.json"));
    }

    public string SnapshotPath(Guid id) => Path.Combine(_dir, id.ToString("N") + ".wfw");

    /// <summary>Saves the whole configuration before a change, and drops the oldest beyond 20.</summary>
    public Guid TakeSnapshot(IFirewallControl firewall, Guid? commandId, DateTimeOffset now)
    {
        lock (_gate)
        {
            Guid id = Guid.NewGuid();
            firewall.Export(SnapshotPath(id));
            Index index = _index.Load();
            index.Snapshots.Add(new FirewallSnapshotInfo { SnapshotId = id, TakenAt = now, CommandId = commandId });
            while (index.Snapshots.Count > KeepSnapshots)
            {
                FirewallSnapshotInfo old = index.Snapshots[0];
                index.Snapshots.RemoveAt(0);
                try { File.Delete(SnapshotPath(old.SnapshotId)); } catch (IOException) { }
            }
            _index.Save(index);
            return id;
        }
    }

    public IReadOnlyList<FirewallSnapshotInfo> Snapshots() { lock (_gate) return _index.Load().Snapshots.OrderByDescending(s => s.TakenAt).ToList(); }

    public bool HasSnapshot(Guid id) { lock (_gate) return _index.Load().Snapshots.Any(s => s.SnapshotId == id) && File.Exists(SnapshotPath(id)); }

    public void SetTimer(FirewallProfile profile, DateTimeOffset reenableAt, Guid commandId)
    {
        lock (_gate)
        {
            Timers t = _timers.Load();
            t.Items.RemoveAll(i => i.Profile == profile);
            t.Items.Add(new Timer { Profile = profile, ReenableAt = reenableAt, CommandId = commandId });
            _timers.Save(t);
        }
    }

    public void ClearTimer(FirewallProfile profile)
    {
        lock (_gate) { Timers t = _timers.Load(); if (t.Items.RemoveAll(i => i.Profile == profile) > 0) _timers.Save(t); }
    }

    public void ClearTimersFor(Guid commandId)
    {
        lock (_gate) { Timers t = _timers.Load(); if (t.Items.RemoveAll(i => i.CommandId == commandId) > 0) _timers.Save(t); }
    }

    public IReadOnlyList<Timer> TimersList() { lock (_gate) return _timers.Load().Items.ToList(); }

    /// <summary>
    /// The timers that are due. They stay on disk until the profile really is on again (see the upkeep's
    /// <see cref="ClearTimer"/>): while a re-enable can still fail, the file is the only record that the profile
    /// must come back on, so a crash or a failure here cannot drop the timer.
    /// </summary>
    public IReadOnlyList<Timer> TakeDue(DateTimeOffset now)
    {
        lock (_gate) return _timers.Load().Items.Where(i => i.ReenableAt <= now).ToList();
    }

    /// <summary>Remembers that the firewall now looks the way this command left it.</summary>
    public void Record(Guid commandId, FirewallStateOutput after, DateTimeOffset now)
    {
        lock (_gate)
        {
            Journal j = _journal.Load();
            j.Items.Add(new JournalEntry { CommandId = commandId, AfterHash = FirewallWatch.Hash(after), At = now });
            if (j.Items.Count > 100) j.Items.RemoveRange(0, j.Items.Count - 100);
            _journal.Save(j);
        }
    }

    /// <summary>The platform command whose change left the firewall exactly like this, if any (newest first).</summary>
    public Guid? CommandFor(string hash)
    {
        lock (_gate) return _journal.Load().Items.LastOrDefault(i => i.AfterHash == hash)?.CommandId;
    }
}
