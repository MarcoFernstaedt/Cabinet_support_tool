using System.Globalization;
using System.Text;

namespace Cabinet.Agent.Core;

/// <summary>
/// Command IDs already seen, kept until their expiry plus clock-skew tolerance
/// (docs/spec/02-security-model.md control 5). Persisted, so restarting the
/// agent does not reopen the window for a replay. After an entry is dropped the
/// command it names is expired, so step 3 refuses it anyway.
/// </summary>
public sealed class ReplayStore
{
    /// <summary>Far above what the local rate limits can produce inside one expiry window.</summary>
    public const int Capacity = 20_000;

    private readonly string? _file;
    private readonly Dictionary<Guid, DateTimeOffset> _seen = new();
    private readonly object _gate = new();
    private int _appendedSinceCompact;

    /// <param name="file">Where to persist; null keeps the store in memory (tests).</param>
    public ReplayStore(string? file, TimeProvider clock)
    {
        _file = file;
        if (file is null || !File.Exists(file)) return;
        DateTimeOffset now = clock.GetUtcNow();
        foreach (string line in File.ReadLines(file))
        {
            // Lines this process did not write in this format are ignored, never trusted.
            string[] parts = line.Split(' ');
            if (parts.Length == 2 && Guid.TryParseExact(parts[0], "D", out Guid id) &&
                long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out long until) &&
                until <= DateTimeOffset.MaxValue.ToUnixTimeSeconds())
            {
                DateTimeOffset keep = DateTimeOffset.FromUnixTimeSeconds(until);
                if (keep > now && _seen.Count < Capacity) _seen[id] = keep;
            }
        }
        Compact();
    }

    public enum Outcome { Recorded, AlreadySeen, Full }

    /// <summary>Atomically checks and records one command ID.</summary>
    public Outcome TryRecord(Guid commandId, DateTimeOffset keepUntil, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_seen.TryGetValue(commandId, out DateTimeOffset existing) && existing > now) return Outcome.AlreadySeen;
            if (_seen.Count >= Capacity)
            {
                foreach (Guid stale in _seen.Where(p => p.Value <= now).Select(p => p.Key).ToList()) _seen.Remove(stale);
                if (_seen.Count >= Capacity) return Outcome.Full;
            }
            _seen[commandId] = keepUntil;
            if (_file is not null)
            {
                File.AppendAllText(_file, Line(commandId, keepUntil));
                if (++_appendedSinceCompact >= 1000)
                {
                    foreach (Guid stale in _seen.Where(p => p.Value <= now).Select(p => p.Key).ToList()) _seen.Remove(stale);
                    Compact();
                }
            }
            return Outcome.Recorded;
        }
    }

    public int Count { get { lock (_gate) return _seen.Count; } }

    private void Compact()
    {
        if (_file is null) return;
        var text = new StringBuilder();
        foreach (var (id, until) in _seen) text.Append(Line(id, until));
        AtomicFile.Write(_file, text.ToString());
        _appendedSinceCompact = 0;
    }

    private static string Line(Guid id, DateTimeOffset until) =>
        $"{id:D} {until.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)}\n";
}

internal static class AtomicFile
{
    /// <summary>Writes to a temporary file beside the target, then replaces it.</summary>
    public static void Write(string path, string contents)
    {
        string temp = path + ".tmp";
        File.WriteAllText(temp, contents);
        File.Move(temp, path, overwrite: true);
    }
}
