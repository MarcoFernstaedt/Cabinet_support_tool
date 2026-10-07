using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Writes;

/// <summary>
/// The safety net (docs/spec/04-agent-spec.md): after a network or firewall change the agent must
/// reach the server within 2 minutes. The network process confirms once it has delivered the
/// command's result; if no confirmation arrives in time the broker puts the old settings back on
/// its own. Pending changes are kept on disk in the broker's folder, so a restart or a reboot
/// inside the window still ends in a rollback.
/// </summary>
public sealed class SafetyNet
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromMinutes(2);

    public enum Kind { Network, Firewall }

    public sealed class Entry
    {
        public Guid CommandId { get; set; }
        public DateTimeOffset ArmedAt { get; set; }
        public DateTimeOffset Deadline { get; set; }
        public Kind What { get; set; }
        public int? InterfaceIndex { get; set; }
        public Ipv4Settings? IpBefore { get; set; }
        public DnsSettings? DnsBefore { get; set; }
        /// <summary>The snapshot taken just before a firewall change.</summary>
        public Guid? SnapshotId { get; set; }
    }

    public sealed class Outcome
    {
        public Guid CommandId { get; set; }
        public SafetyNetState State { get; set; }
        public DateTimeOffset At { get; set; }
    }

    public sealed class State
    {
        public List<Entry> Pending { get; set; } = new();
        public List<Outcome> Done { get; set; } = new();
    }

    private readonly StateFile<State> _store;
    private readonly TimeProvider _clock;
    private readonly object _gate = new();
    public TimeSpan Window { get; }

    public SafetyNet(string? path, TimeProvider clock, TimeSpan? window = null)
    {
        _store = new StateFile<State>(path);
        _clock = clock;
        Window = window ?? DefaultWindow;
    }

    /// <summary>Starts the window for a change. Returns its deadline.</summary>
    public DateTimeOffset Arm(Entry entry)
    {
        lock (_gate)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            entry.ArmedAt = now;
            entry.Deadline = now + Window;
            State s = _store.Load();
            s.Pending.RemoveAll(p => p.CommandId == entry.CommandId);
            s.Pending.Add(entry);
            _store.Save(s);
            return entry.Deadline;
        }
    }

    /// <summary>The server was reached: keep the change, unless it has already been rolled back.</summary>
    public SafetyNetStatus Confirm(Guid commandId)
    {
        lock (_gate)
        {
            State s = _store.Load();
            Entry? pending = s.Pending.FirstOrDefault(p => p.CommandId == commandId);
            if (pending is not null)
            {
                s.Pending.Remove(pending);
                Record(s, commandId, SafetyNetState.Kept);
                _store.Save(s);
                return new SafetyNetStatus { CommandId = commandId, State = SafetyNetState.Kept };
            }
            Outcome? done = s.Done.LastOrDefault(d => d.CommandId == commandId);
            return done is null
                ? new SafetyNetStatus { CommandId = commandId, State = SafetyNetState.Unknown }
                : new SafetyNetStatus { CommandId = commandId, State = done.State, RolledBackAt = done.State == SafetyNetState.RolledBack ? done.At : null };
        }
    }

    public IReadOnlyList<Entry> Pending { get { lock (_gate) return _store.Load().Pending.ToList(); } }

    /// <summary>
    /// Rolls back every change whose time ran out, and every later change still waiting, newest first,
    /// so the settings end as they were before the oldest unconfirmed change.
    /// </summary>
    /// <returns>The commands that were rolled back.</returns>
    public IReadOnlyList<Guid> Expire(Action<Entry> rollback, Action<string> log)
    {
        lock (_gate)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            State s = _store.Load();
            // Pending is kept in the order changes were made, which also settles two changes made in the same instant.
            int first = s.Pending.FindIndex(p => p.Deadline <= now);
            if (first < 0) return Array.Empty<Guid>();
            var undo = s.Pending.Skip(first).Reverse().ToList();
            foreach (Entry e in undo)
            {
                try { rollback(e); }
                catch (Exception ex)
                {
                    // Recorded as rolled back either way: the change is no longer trusted, and a security event reports it.
                    log($"Safety net: rolling back command {e.CommandId} failed ({ex.GetType().Name}: {OperationRunner.Truncate(ex.Message)}).");
                }
                s.Pending.Remove(e);
                Record(s, e.CommandId, SafetyNetState.RolledBack);
                log($"Safety net: the server was not reached within {Window.TotalSeconds:0} s of command {e.CommandId}; its change was rolled back.");
            }
            _store.Save(s);
            return undo.Select(e => e.CommandId).ToList();
        }
    }

    private void Record(State s, Guid commandId, SafetyNetState state)
    {
        s.Done.Add(new Outcome { CommandId = commandId, State = state, At = _clock.GetUtcNow() });
        if (s.Done.Count > 200) s.Done.RemoveRange(0, s.Done.Count - 200);
    }
}
