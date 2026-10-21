using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Configuration;

/// <summary>
/// Configuration snapshots waiting to reach the server: kept on disk so a restart or an outage loses nothing, bounded (30
/// snapshots, 4 MB) with the oldest dropped first, sent oldest first, each checked against its contract before it is kept. When an
/// older snapshot of a category is dropped the next one of that category says so (<c>gapBefore</c>), so the server knows changes
/// in between are unknown instead of assuming there were none. One line of the file is one snapshot exactly as it is sent.
/// </summary>
public sealed class ConfigQueue
{
    public const int MaxEntries = 30;
    public const int MaxBytes = 4 * 1024 * 1024;
    public const int MaxBatch = 8;
    /// <summary>One upload stays well under the server's 1 MB request limit; a single snapshot is always sent alone if it is the only one that fits.</summary>
    public const int MaxBodyBytes = 700 * 1024;

    private sealed class Entry { public required ConfigCategory Category; public required string Json; }

    private readonly string? _file;
    private readonly LinkedList<Entry> _entries = new();
    private readonly HashSet<ConfigCategory> _gap = new();
    private readonly object _gate = new();
    public int Dropped { get; private set; }

    /// <summary>Raised with the categories of snapshots the server refused, so the watcher sends them again at the next look.</summary>
    public event Action<IReadOnlyList<ConfigCategory>>? Discarded;

    public ConfigQueue(string? file)
    {
        _file = file;
        if (file is null || !File.Exists(file) || new FileInfo(file).Length > 2L * MaxBytes) return;
        try
        {
            foreach (string line in File.ReadLines(file))
            {
                if (line.Length == 0 || line.Length > MaxBytes || !StrictJson.TryParse(Encoding.UTF8.GetBytes(line), MaxBytes, out JsonDocument? doc)) continue;
                using (doc)
                {
                    if (!Valid(line) || !doc!.RootElement.TryGetProperty("category", out JsonElement name) || !TryCategory(name.GetString(), out ConfigCategory category)) continue;
                    _entries.AddLast(new Entry { Category = category, Json = line });
                }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return; }
        Trim();
    }

    private static bool TryCategory(string? name, out ConfigCategory category)
    {
        foreach (ConfigCategory c in Enum.GetValues<ConfigCategory>())
            if (string.Equals(JsonNamingPolicy.SnakeCaseLower.ConvertName(c.ToString()), name, StringComparison.Ordinal)) { category = c; return true; }
        category = default;
        return false;
    }

    public int Count { get { lock (_gate) return _entries.Count; } }

    private static string Line(ConfigUploadSnapshot s) => JsonSerializer.Serialize(s, ContractJson.Options);

    /// <summary>One snapshot is valid when an upload holding only it matches the config-upload contract.</summary>
    private static bool Valid(string snapshotJson)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse("{\"snapshots\":[" + snapshotJson + "]}");
            return ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("config-upload"), doc.RootElement);
        }
        catch (JsonException) { return false; }
    }

    /// <returns>False when the snapshot does not match its contract (it is not kept).</returns>
    public bool Enqueue(ConfigUploadSnapshot snapshot)
    {
        lock (_gate)
        {
            if (_gap.Contains(snapshot.Category)) snapshot = snapshot with { GapBefore = true };
            string line = Line(snapshot);
            if (!Valid(line)) return false;
            _gap.Remove(snapshot.Category);
            _entries.AddLast(new Entry { Category = snapshot.Category, Json = line });
            Trim();
            Persist();
            return true;
        }
    }

    private void Trim()
    {
        long bytes = _entries.Sum(e => (long)e.Json.Length + 1);
        while (_entries.Count > 0 && (_entries.Count > MaxEntries || bytes > MaxBytes))
        {
            Entry oldest = _entries.First!.Value;
            bytes -= oldest.Json.Length + 1;
            _entries.RemoveFirst();
            Dropped++;
            // The next snapshot of this category (queued or yet to come) must say that something before it was lost.
            LinkedListNode<Entry>? next = _entries.First;
            while (next is not null && next.Value.Category != oldest.Category) next = next.Next;
            if (next is null) _gap.Add(oldest.Category);
            else
            {
                var snapshot = JsonSerializer.Deserialize<ConfigUploadSnapshot>(next.Value.Json, ContractJson.Options)!;
                string marked = Line(snapshot with { GapBefore = true });
                bytes += marked.Length - next.Value.Json.Length;
                next.Value.Json = marked;
            }
        }
    }

    /// <summary>The oldest snapshots that fit in one request (at most <see cref="MaxBatch"/> and <see cref="MaxBodyBytes"/>, and always at least one) as the request body.</summary>
    public (string Body, int Count)? Peek(int max = MaxBatch)
    {
        lock (_gate)
        {
            var take = new List<string>();
            long bytes = 16;
            foreach (Entry e in _entries)
            {
                if (take.Count >= Math.Min(max, MaxBatch) || (take.Count > 0 && bytes + e.Json.Length + 1 > MaxBodyBytes)) break;
                take.Add(e.Json);
                bytes += e.Json.Length + 1;
            }
            return take.Count == 0 ? null : ("{\"snapshots\":[" + string.Join(',', take) + "]}", take.Count);
        }
    }

    /// <summary>Removes the oldest <paramref name="count"/> snapshots, which the server has accepted.</summary>
    public void Acknowledge(int count)
    {
        lock (_gate)
        {
            for (int i = 0; i < count && _entries.Count > 0; i++) _entries.RemoveFirst();
            Persist();
        }
    }

    /// <summary>Removes the oldest <paramref name="count"/> snapshots, which the server refused; their categories are looked at again.</summary>
    public void Discard(int count)
    {
        List<ConfigCategory> categories = [];
        lock (_gate)
        {
            for (int i = 0; i < count && _entries.Count > 0; i++) { categories.Add(_entries.First!.Value.Category); _entries.RemoveFirst(); }
            Persist();
        }
        if (categories.Count > 0) Discarded?.Invoke(categories.Distinct().ToList());
    }

    private void Persist()
    {
        if (_file is null) return;
        var text = new StringBuilder();
        foreach (Entry e in _entries) text.Append(e.Json).Append('\n');
        AtomicFile.Write(_file, text.ToString());
    }
}
