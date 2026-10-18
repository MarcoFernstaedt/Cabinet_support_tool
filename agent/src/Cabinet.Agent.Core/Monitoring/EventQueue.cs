using System.Globalization;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// Events waiting to reach the server (docs/spec/03-protocol.md, protocol 1.1 "Events"): kept on disk so a
/// restart or an outage loses nothing, sent oldest first. Every event is checked against its contract before
/// it is kept and again when it is read back.
///
/// Two lanes. Security and agent-status events go in a small lane of their own that is never evicted (and is
/// sent first); everything else goes in the main lane, capped in count and bytes with the oldest dropped first.
/// Each lane is an append-only file plus a small acknowledgement file holding the offset of the first event not
/// yet accepted, so an enqueue appends one line instead of rewriting the queue. The file is compacted now and
/// then into a new generation; the acknowledgement file names the generation, so a crash at any point leaves
/// either the old queue or the new one. A torn last line (a crash mid-append) is cut off on load.
/// </summary>
public sealed class EventQueue
{
    public const int MaxEvents = 5_000;
    public const long MaxBytes = 16L * 1024 * 1024;
    public const int MaxPriorityEvents = 1_000;
    public const long MaxPriorityBytes = 4L * 1024 * 1024;
    public const int MaxBatch = 100;
    /// <summary>Protocol 1.1: an event batch is also capped at 256 KB.</summary>
    public const int MaxBatchBytes = 256 * 1024;
    public const int MaxEventBytes = 64 * 1024;
    public const long MaxDeadLetterBytes = 1024 * 1024;

    private readonly Lane _main;
    private readonly Lane _priority;
    private readonly string? _deadLetter;
    private readonly HashSet<Guid> _ids = new();
    private readonly object _gate = new();

    /// <param name="file">Where to persist (the lanes and their acknowledgement files sit beside it); null keeps the queue in memory (tests).</param>
    public EventQueue(string? file)
    {
        _main = new Lane(file is null ? null : file + ".main", MaxEvents, MaxBytes, evicts: true);
        _priority = new Lane(file is null ? null : file + ".priority", MaxPriorityEvents, MaxPriorityBytes, evicts: false);
        _deadLetter = file is null ? null : file + ".set-aside.jsonl";
        _main.Load(_ids);
        _priority.Load(_ids);
        // The queue before protocol 1.1 was one file rewritten on every change: take its events over once.
        if (file is not null && File.Exists(file))
        {
            foreach (string line in File.ReadLines(file))
                if (Parse(line) is { } e && _ids.Add(e.Id)) (e.Priority ? _priority : _main).Add(e.Id, line, flushToDisk: false);
            _main.Compact();
            _priority.Compact();
            File.Delete(file);
        }
    }

    public int Count { get { lock (_gate) return _main.Count + _priority.Count; } }
    public int PriorityCount { get { lock (_gate) return _priority.Count; } }

    /// <summary>Events dropped because the queue was full (oldest of the main lane, or new ones when the priority lane was full), across restarts.</summary>
    public long Dropped { get { lock (_gate) return _main.Dropped + _priority.Dropped; } }

    /// <summary>Events set aside because the server kept refusing them (kept in a small file for an administrator), across restarts.</summary>
    public long SetAside { get { lock (_gate) return _main.SetAside + _priority.SetAside; } }

    public static bool IsPriority(EventKind kind) => kind is EventKind.Security or EventKind.AgentStatus;

    /// <returns>False if the event is not valid, is too large, is already queued, or the priority lane is full.</returns>
    public bool Enqueue(AgentEvent e)
    {
        string json = JsonSerializer.Serialize(e, ContractJson.Options);
        if (Encoding.UTF8.GetByteCount(json) > MaxEventBytes - 1) return false;
        using (JsonDocument doc = JsonDocument.Parse(json))
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("event"), doc.RootElement)) return false;
        bool priority = IsPriority(e.Kind);
        lock (_gate)
        {
            if (_ids.Contains(e.EventId)) return false;
            Lane lane = priority ? _priority : _main;
            if (!lane.Add(e.EventId, json, flushToDisk: priority)) return false;
            _ids.Add(e.EventId);
            foreach (Guid evicted in lane.Evict()) _ids.Remove(evicted);
            return true;
        }
    }

    /// <summary>The oldest events, up to a batch, as their JSON: the priority lane first.</summary>
    public IReadOnlyList<(Guid Id, string Json)> Peek(int max = MaxBatch) => PeekBatch(max, int.MaxValue);

    /// <summary>The oldest events of one lane (priority first), at most <paramref name="maxCount"/> (and 100) and <paramref name="maxBytes"/> of event JSON; always at least one when any is queued.</summary>
    public IReadOnlyList<(Guid Id, string Json)> PeekBatch(int maxCount, int maxBytes = MaxBatchBytes)
    {
        lock (_gate)
        {
            Lane lane = _priority.Count > 0 ? _priority : _main;
            return lane.Peek(Math.Clamp(maxCount, 1, MaxBatch), maxBytes);
        }
    }

    /// <summary>Removes events the server has accepted.</summary>
    public void Acknowledge(IEnumerable<Guid> ids)
    {
        var done = ids.ToHashSet();
        lock (_gate)
        {
            _main.Remove(done);
            _priority.Remove(done);
            _ids.ExceptWith(done);
        }
    }

    /// <summary>Sets one event aside: the server keeps refusing it, and it must not stall the events behind it.</summary>
    public void SetAsideEvent(Guid id)
    {
        lock (_gate)
        {
            string? json = _priority.Find(id) ?? _main.Find(id);
            if (json is null) return;
            Lane lane = _priority.Find(id) is not null ? _priority : _main;
            if (_deadLetter is not null)
            {
                try
                {
                    long size = File.Exists(_deadLetter) ? new FileInfo(_deadLetter).Length : 0;
                    if (size + json.Length < MaxDeadLetterBytes) File.AppendAllText(_deadLetter, json + "\n");
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            }
            lane.SetAsideOne(id);
            _ids.Remove(id);
        }
    }

    private static (Guid Id, bool Priority)? Parse(string line)
    {
        if (line.Length == 0 || !StrictJson.TryParse(Encoding.UTF8.GetBytes(line), MaxEventBytes, out JsonDocument? doc)) return null;
        using (doc)
        {
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("event"), doc!.RootElement)) return null;
            string kind = doc.RootElement.GetProperty("kind").GetString()!;
            return (doc.RootElement.GetProperty("eventId").GetGuid(), kind is "security" or "agent_status");
        }
    }

    /// <summary>One lane: an append-only file of JSON lines and an acknowledgement file "generation offset dropped setAside".</summary>
    private sealed class Lane(string? basePath, int maxEvents, long maxBytes, bool evicts)
    {
        private sealed record Entry(Guid Id, string Json, long End, int Bytes);

        private readonly LinkedList<Entry> _entries = new();
        private long _generation;
        private long _ackOffset;
        private long _length;
        private long _liveBytes;
        public long Dropped { get; private set; }
        public long SetAside { get; private set; }
        public int Count => _entries.Count;

        private string DataPath(long generation) => $"{basePath}.{generation.ToString(CultureInfo.InvariantCulture)}.jsonl";
        private string AckPath => basePath + ".ack";

        public void Load(HashSet<Guid> ids)
        {
            if (basePath is null) return;
            string? directory = Path.GetDirectoryName(Path.GetFullPath(basePath));
            if (directory is not null) Directory.CreateDirectory(directory);
            if (File.Exists(AckPath))
            {
                string[] parts = File.ReadAllText(AckPath).Trim().Split(' ');
                if (parts.Length == 4 && long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out long g) &&
                    long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out long o) &&
                    long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out long d) &&
                    long.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out long s))
                    (_generation, _ackOffset, Dropped, SetAside) = (g, o, d, s);
            }
            // Generations the acknowledgement file does not name are a compaction that did not finish, or one that did: either way not ours now.
            string name = Path.GetFileName(basePath);
            if (directory is not null)
                foreach (string other in Directory.EnumerateFiles(directory, name + ".*.jsonl"))
                    if (!string.Equals(Path.GetFullPath(other), Path.GetFullPath(DataPath(_generation)), StringComparison.Ordinal)) File.Delete(other);
            string data = DataPath(_generation);
            if (!File.Exists(data)) { _ackOffset = 0; _length = 0; return; }
            byte[] bytes = File.ReadAllBytes(data);
            if (_ackOffset > bytes.Length) _ackOffset = bytes.Length;
            int lastNewline = Array.LastIndexOf(bytes, (byte)'\n');
            long complete = lastNewline + 1;
            if (complete < bytes.Length)
                using (var f = new FileStream(data, FileMode.Open, FileAccess.Write)) f.SetLength(complete); // a torn last line
            _length = complete;
            if (_ackOffset > complete) _ackOffset = complete;
            long start = _ackOffset;
            for (long i = start; i < complete; i++)
            {
                if (bytes[i] != (byte)'\n') continue;
                int count = (int)(i - start);
                if (count <= MaxEventBytes)
                {
                    string line = Encoding.UTF8.GetString(bytes, (int)start, count);
                    if (Parse(line) is { } e && ids.Add(e.Id)) { _entries.AddLast(new Entry(e.Id, line, i + 1, count + 1)); _liveBytes += count + 1; }
                }
                start = i + 1;
            }
            if (_ackOffset > 0) Compact();
        }

        public bool Add(Guid id, string json, bool flushToDisk)
        {
            int bytes = Encoding.UTF8.GetByteCount(json) + 1;
            if (!evicts && (_entries.Count >= maxEvents || _liveBytes + bytes > maxBytes)) { Dropped++; WriteAck(); return false; }
            if (basePath is not null)
            {
                using var file = new FileStream(DataPath(_generation), FileMode.Append, FileAccess.Write, FileShare.Read);
                file.Write(Encoding.UTF8.GetBytes(json + "\n"));
                file.Flush(flushToDisk);
            }
            _length += bytes;
            _liveBytes += bytes;
            _entries.AddLast(new Entry(id, json, _length, bytes));
            return true;
        }

        /// <summary>Drops the oldest events while the lane is over its caps (main lane only).</summary>
        public List<Guid> Evict()
        {
            var evicted = new List<Guid>();
            if (!evicts) return evicted;
            while (_entries.Count > 0 && (_entries.Count > maxEvents || _liveBytes > maxBytes))
            {
                evicted.Add(_entries.First!.Value.Id);
                RemoveFirst();
                Dropped++;
            }
            if (evicted.Count > 0) AdvanceAck();
            return evicted;
        }

        public IReadOnlyList<(Guid Id, string Json)> Peek(int maxCount, int maxBytes)
        {
            var batch = new List<(Guid, string)>();
            long bytes = 0;
            foreach (Entry e in _entries)
            {
                if (batch.Count >= maxCount || (batch.Count > 0 && bytes + e.Bytes > maxBytes)) break;
                batch.Add((e.Id, e.Json));
                bytes += e.Bytes;
            }
            return batch;
        }

        public string? Find(Guid id) => _entries.FirstOrDefault(e => e.Id == id)?.Json;

        public void SetAsideOne(Guid id)
        {
            SetAside++;
            Remove(new HashSet<Guid> { id });
            WriteAck();
        }

        public void Remove(HashSet<Guid> ids)
        {
            bool hole = false, any = false;
            bool prefix = true;
            for (var node = _entries.First; node is not null;)
            {
                var next = node.Next;
                if (ids.Contains(node.Value.Id))
                {
                    any = true;
                    if (!prefix) hole = true;
                    if (prefix) RemoveFirst(); else { _liveBytes -= node.Value.Bytes; _entries.Remove(node); }
                }
                else prefix = false;
                node = next;
            }
            if (!any) return;
            // An event removed from the middle cannot be marked by the offset alone: rewrite the lane so it does not come back after a restart.
            if (hole) Compact(); else AdvanceAck();
        }

        private void RemoveFirst()
        {
            _liveBytes -= _entries.First!.Value.Bytes;
            _entries.RemoveFirst();
        }

        private void AdvanceAck()
        {
            _ackOffset = _entries.First is { } first ? first.Value.End - first.Value.Bytes : _length;
            if (_ackOffset >= 1024 * 1024 && _ackOffset * 2 >= _length) Compact();
            else WriteAck();
        }

        /// <summary>Writes the live events to the next generation, then switches the acknowledgement file to it, then deletes the old one.</summary>
        public void Compact()
        {
            if (basePath is null) { RecomputeOffsets(); _ackOffset = 0; return; }
            long next = _generation + 1;
            using (var file = new FileStream(DataPath(next), FileMode.Create, FileAccess.Write, FileShare.Read))
            {
                foreach (Entry e in _entries) file.Write(Encoding.UTF8.GetBytes(e.Json + "\n"));
                file.Flush(flushToDisk: true);
            }
            long old = _generation;
            _generation = next;
            _ackOffset = 0;
            RecomputeOffsets();
            WriteAck();
            try { File.Delete(DataPath(old)); } catch (IOException) { }
        }

        private void RecomputeOffsets()
        {
            long at = 0;
            var rebuilt = _entries.Select(e => { at += e.Bytes; return e with { End = at }; }).ToList();
            _entries.Clear();
            foreach (Entry e in rebuilt) _entries.AddLast(e);
            _length = at;
        }

        private void WriteAck()
        {
            if (basePath is null) return;
            AtomicFile.Write(AckPath, string.Create(CultureInfo.InvariantCulture, $"{_generation} {_ackOffset} {Dropped} {SetAside}\n"));
        }
    }
}

/// <summary>Event IDs derived from what the event is about, so the same Windows record is never reported twice.</summary>
public static class EventIds
{
    public static Guid For(string text)
    {
        byte[] hash = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(text));
        byte[] g = hash[..16];
        g[7] = (byte)((g[7] & 0x0F) | 0x50); // version 5-style marker
        g[8] = (byte)((g[8] & 0x3F) | 0x80); // RFC 4122 variant
        return new Guid(g);
    }
}
