using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Configuration;

/// <summary>
/// The change-only reporter (docs/spec/15-baselines-and-config.md). It remembers the hash of each category it last queued; a
/// category whose hash is unchanged queues nothing, so a healthy cabinet is silent between changes. Every category is also
/// queued again after 24 hours even when unchanged, which lets the server confirm it still holds the current version (and heal
/// if it ever lost it). The first look is queued as the starting point.
/// </summary>
public sealed class ConfigWatch(StateFile<ConfigWatch.State> store, ConfigQueue queue, TimeProvider clock, Action<string> log)
{
    public static readonly TimeSpan Refresh = TimeSpan.FromHours(24);
    private readonly object _gate = new();

    public sealed class State
    {
        public Dictionary<string, string> Hashes { get; set; } = new();
        public Dictionary<string, DateTimeOffset> SentAt { get; set; } = new();
    }

    /// <summary>Queues what changed (or is due); returns how many snapshots were queued.</summary>
    public int Observe(ConfigSnapshotOutput snapshot)
    {
        lock (_gate) return ObserveLocked(snapshot);
    }

    private int ObserveLocked(ConfigSnapshotOutput snapshot)
    {
        State state = store.Load();
        DateTimeOffset now = clock.GetUtcNow();
        int queued = 0;
        foreach (ConfigSnapshotCategory c in snapshot.Categories)
        {
            string name = c.Category.ToString();
            bool changed = !state.Hashes.TryGetValue(name, out string? last) || last != c.Hash;
            bool due = !state.SentAt.TryGetValue(name, out DateTimeOffset at) || now - at >= Refresh || at > now;
            if (!changed && !due) continue;
            var upload = new ConfigUploadSnapshot { ObservedAt = snapshot.TakenAt, Category = c.Category, Hash = c.Hash, Truncated = c.Truncated, Items = c.Items };
            if (!queue.Enqueue(upload)) { log($"Configuration: the {name.ToLowerInvariant()} snapshot did not match its contract at {queue.LastRefusal} and was not queued."); continue; }
            state.Hashes[name] = c.Hash;
            state.SentAt[name] = now;
            queued++;
        }
        if (queued > 0) store.Save(state);
        return queued;
    }

    /// <summary>Forgets what was sent for these categories, so the next look queues them again (the server refused them).</summary>
    public void Forget(IEnumerable<ConfigCategory> categories)
    {
        lock (_gate)
        {
            State state = store.Load();
            foreach (ConfigCategory c in categories) { state.Hashes.Remove(c.ToString()); state.SentAt.Remove(c.ToString()); }
            store.Save(state);
        }
    }
}
