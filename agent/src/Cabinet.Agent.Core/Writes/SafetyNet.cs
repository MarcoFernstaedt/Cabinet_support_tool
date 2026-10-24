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
/// A change that could not be put back is not forgotten: it stays pending with its failure on disk
/// and is tried again, so "rolled back" is only ever recorded for a rollback that worked.
/// </summary>
public sealed class SafetyNet
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromMinutes(2);

    /// <summary>How long after a failed rollback the next attempt is made: often enough to recover by itself, rarely enough not to spin.</summary>
    public static readonly TimeSpan RetryFailedAfter = TimeSpan.FromMinutes(1);

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
        /// <summary>How many times putting this change back has failed (0 while none has). The change is not trusted until an attempt works.</summary>
        public int RollbackFailures { get; set; }
        /// <summary>When putting this change back last failed, or null. A change with this set is still in place and is tried again.</summary>
        public DateTimeOffset? RollbackFailedAt { get; set; }
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
        // Critical: a change that is waiting to be put back must not be lost to a file that cannot be read.
        _store = new StateFile<State>(path, critical: path is not null);
        _clock = clock;
        Window = window ?? DefaultWindow;
    }

    /// <summary>
    /// Starts the window for a change. Returns its deadline. Called before the change is made, never after:
    /// the broker must have a record of how to undo a change before Windows is asked to make it.
    /// </summary>
    public DateTimeOffset Arm(Entry entry)
    {
        lock (_gate)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            State s = _store.Load();
            if (_store.LastLoadFailed)
            {
                // The record of changes waiting to be put back cannot be read, so nothing new may be armed: an
                // unknown change could still be covered by it. No change was made, and a visit is needed.
                throw new OperationFailedException("execution_failed", "The broker's record of changes waiting to be put back cannot be read, so this change was not made. The cabinet needs a visit.");
            }
            entry.ArmedAt = now;
            entry.Deadline = now + Window;
            s.Pending.RemoveAll(p => p.CommandId == entry.CommandId);
            s.Pending.Add(entry);
            _store.Save(s);
            return entry.Deadline;
        }
    }

    /// <summary>
    /// The server was reached: keep the change, unless its window has run out or it has already been rolled back.
    /// A confirmation that arrives after the deadline cannot keep the change, because the broker is already putting
    /// it back.
    /// </summary>
    public SafetyNetStatus Confirm(Guid commandId)
    {
        lock (_gate)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            State s = _store.Load();
            if (_store.LastLoadFailed)
            {
                // Nothing can be said to have been kept while the record of pending changes cannot be read, so the
                // change stays under the safety net rather than being answered for as if it were safe.
                return new SafetyNetStatus { CommandId = commandId, State = SafetyNetState.Unknown };
            }
            Entry? pending = s.Pending.FirstOrDefault(p => p.CommandId == commandId);
            if (pending is not null)
            {
                if (pending.Deadline <= now)
                    return new SafetyNetStatus { CommandId = commandId, State = SafetyNetState.Unknown };
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
    /// <param name="rollback">Puts one change's saved settings back; it throws when Windows refuses.</param>
    /// <param name="log">Where every attempt is reported.</param>
    /// <param name="rollbackFailed">Called with the command ID of a change that could not be put back, so a security event can say so.</param>
    /// <returns>The commands whose change was put back.</returns>
    public IReadOnlyList<Guid> Expire(Action<Entry> rollback, Action<string> log, Action<Guid>? rollbackFailed = null)
    {
        lock (_gate)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            State s = _store.Load();
            if (_store.LastLoadFailed)
            {
                log("Safety net: the record of changes waiting to be put back cannot be read, so no change could be put back and none is being armed until it can be.");
                return Array.Empty<Guid>();
            }
            // Pending is kept in the order changes were made, which also settles two changes made in the same instant.
            int first = s.Pending.FindIndex(p => p.Deadline <= now);
            if (first < 0) return Array.Empty<Guid>();
            var undo = s.Pending.Skip(first).Reverse().ToList();
            var undone = new List<Guid>();
            foreach (Entry e in undo)
            {
                if (e.RollbackFailedAt is { } failed && now - failed < RetryFailedAfter) continue;
                try { rollback(e); }
                catch (Exception ex)
                {
                    // The change is still in place: it keeps its place on disk with the failure noted, is reported as a
                    // security event, and is tried again. Only a rollback that worked is ever recorded as one.
                    e.RollbackFailures++;
                    e.RollbackFailedAt = now;
                    log($"Safety net: putting command {e.CommandId}'s change back failed ({ex.GetType().Name}: {OperationRunner.Truncate(ex.Message)}); the change is still in place and the next attempt is {RetryFailedAfter.TotalSeconds:0} s away.");
                    rollbackFailed?.Invoke(e.CommandId);
                    continue;
                }
                e.RollbackFailures = 0;
                e.RollbackFailedAt = null;
                s.Pending.Remove(e);
                undone.Add(e.CommandId);
                Record(s, e.CommandId, SafetyNetState.RolledBack);
                log($"Safety net: the server was not reached within {Window.TotalSeconds:0} s of command {e.CommandId}; its change was rolled back.");
            }
            _store.Save(s);
            return undone;
        }
    }

    private void Record(State s, Guid commandId, SafetyNetState state)
    {
        s.Done.Add(new Outcome { CommandId = commandId, State = state, At = _clock.GetUtcNow() });
        if (s.Done.Count > 200) s.Done.RemoveRange(0, s.Done.Count - 200);
    }
}
