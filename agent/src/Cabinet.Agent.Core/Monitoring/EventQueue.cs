using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// Events waiting to reach the server (docs/spec/03-protocol.md): kept on disk so a
/// restart or an outage loses nothing, capped in size with the oldest dropped first,
/// sent oldest first. Every event is checked against its contract before it is kept.
/// </summary>
public sealed class EventQueue
{
    public const int MaxEvents = 5_000;
    public const int MaxBatch = 100;

    private readonly string? _file;
    private readonly LinkedList<(Guid Id, string Json)> _events = new();
    private readonly HashSet<Guid> _ids = new();
    private readonly object _gate = new();
    public int Dropped { get; private set; }

    /// <param name="file">Where to persist; null keeps the queue in memory (tests).</param>
    public EventQueue(string? file)
    {
        _file = file;
        if (file is null || !File.Exists(file)) return;
        foreach (string line in File.ReadLines(file))
        {
            // A line that does not parse or no longer matches the contract is dropped, never sent.
            if (!StrictJson.TryParse(Encoding.UTF8.GetBytes(line), 64 * 1024, out JsonDocument? doc)) continue;
            using (doc)
            {
                if (!ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("event"), doc!.RootElement)) continue;
                Guid id = doc.RootElement.GetProperty("eventId").GetGuid();
                if (_ids.Add(id)) _events.AddLast((id, line));
            }
        }
        while (_events.Count > MaxEvents) RemoveFirst();
    }

    public int Count { get { lock (_gate) return _events.Count; } }

    /// <returns>False if the event is not valid or is already queued.</returns>
    public bool Enqueue(AgentEvent e)
    {
        string json = JsonSerializer.Serialize(e, ContractJson.Options);
        using (JsonDocument doc = JsonDocument.Parse(json))
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("event"), doc.RootElement)) return false;
        lock (_gate)
        {
            if (!_ids.Add(e.EventId)) return false;
            _events.AddLast((e.EventId, json));
            while (_events.Count > MaxEvents) { RemoveFirst(); Dropped++; }
            Persist();
            return true;
        }
    }

    /// <summary>The oldest events, up to a batch, as their JSON.</summary>
    public IReadOnlyList<(Guid Id, string Json)> Peek(int max = MaxBatch)
    {
        lock (_gate) return _events.Take(Math.Min(max, MaxBatch)).ToList();
    }

    /// <summary>Removes events the server has accepted.</summary>
    public void Acknowledge(IEnumerable<Guid> ids)
    {
        lock (_gate)
        {
            var done = ids.ToHashSet();
            for (var node = _events.First; node is not null;)
            {
                var next = node.Next;
                if (done.Contains(node.Value.Id)) { _ids.Remove(node.Value.Id); _events.Remove(node); }
                node = next;
            }
            Persist();
        }
    }

    private void RemoveFirst()
    {
        _ids.Remove(_events.First!.Value.Id);
        _events.RemoveFirst();
    }

    private void Persist()
    {
        if (_file is null) return;
        var text = new StringBuilder();
        foreach (var (_, json) in _events) text.Append(json).Append('\n');
        AtomicFile.Write(_file, text.ToString());
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
