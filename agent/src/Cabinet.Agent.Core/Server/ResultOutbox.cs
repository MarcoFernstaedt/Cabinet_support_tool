using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Server;

/// <summary>
/// Results on disk (protocol 1.1 "Durable results"). Every result is written here, atomically, before
/// it is posted; a sender posts it until the server accepts it, across outages and restarts. Delivered
/// results stay a while longer so a command the server offers again (its lease ran out because the
/// answer to a poll was lost) is answered from here instead of being refused as a replay.
/// A result is only ever forgotten once its file has really been moved: a transition that fails leaves
/// it in the outbox, where posting it again is harmless and losing it is not.
/// Lives under the agent's state folder, so it has that folder's access list (SYSTEM, Administrators
/// and the network service's account). Files are named only by command ID; what is read back is checked
/// against the result contract again before it is sent.
/// </summary>
public sealed class ResultOutbox
{
    /// <summary>The server's request cap is 1 MB; a result bigger than this is replaced by a failure saying so.</summary>
    public const int MaxResultBytes = 1_000_000;
    public const int MaxPending = 1_000;
    public const long MaxPendingBytes = 64L * 1024 * 1024;
    public const int MaxDone = 2_000;
    /// <summary>Longer than any command's lifetime (5 minutes) plus clock skew, so every repeat offer is covered.</summary>
    public static readonly TimeSpan KeepDelivered = TimeSpan.FromHours(2);

    public enum State { None, Pending, Delivered }

    private readonly string _pending;
    private readonly string _done;
    private readonly TimeProvider _clock;
    private readonly Action<string> _log;
    private readonly object _gate = new();
    /// <summary>Pending command IDs, oldest first.</summary>
    private readonly List<Guid> _queue = new();
    private readonly Dictionary<Guid, long> _sizes = new();
    private readonly Dictionary<Guid, DateTimeOffset> _delivered = new();
    private TaskCompletionSource _added = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public ResultOutbox(string folder, TimeProvider clock, Action<string> log)
    {
        _pending = Path.Combine(folder, "pending");
        _done = Path.Combine(folder, "done");
        _clock = clock;
        _log = log;
        Directory.CreateDirectory(_pending);
        Directory.CreateDirectory(_done);
        foreach (string temp in Directory.EnumerateFiles(folder, "*.tmp", SearchOption.AllDirectories)) TryDelete(temp);
        foreach (var file in new DirectoryInfo(_pending).EnumerateFiles("*.json").OrderBy(f => f.LastWriteTimeUtc).ThenBy(f => f.Name, StringComparer.Ordinal))
        {
            if (Id(file.Name) is { } id && file.Length <= MaxResultBytes && Read(file.FullName, id) is not null) { _queue.Add(id); _sizes[id] = file.Length; }
            else TryDelete(file.FullName); // not ours, damaged or no longer matching the contract: never sent
        }
        DateTimeOffset now = clock.GetUtcNow();
        foreach (var file in new DirectoryInfo(_done).EnumerateFiles("*.json"))
        {
            if (Id(file.Name) is { } id && now - new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero) < KeepDelivered && !_sizes.ContainsKey(id))
                _delivered[id] = new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero);
            else TryDelete(file.FullName);
        }
        Prune(now);
    }

    public int PendingCount { get { lock (_gate) return _queue.Count; } }

    public State StateOf(Guid commandId)
    {
        lock (_gate) return _sizes.ContainsKey(commandId) ? State.Pending : _delivered.ContainsKey(commandId) ? State.Delivered : State.None;
    }

    /// <summary>Writes a result to the outbox (replacing any earlier one for the same command) so the sender delivers it.</summary>
    public void Add(Result result)
    {
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(result, ContractJson.Options);
        if (json.Length > MaxResultBytes)
        {
            json = JsonSerializer.SerializeToUtf8Bytes(result with
            {
                Status = ResultStatus.Failed, Output = null,
                Error = new ResultError { Code = "execution_failed", Message = "The operation's output was larger than the agent may send." },
            }, ContractJson.Options);
        }
        lock (_gate)
        {
            string path = PendingPath(result.CommandId);
            WriteAtomic(path, json);
            TryDelete(DonePath(result.CommandId));
            _delivered.Remove(result.CommandId);
            _queue.Remove(result.CommandId);
            _queue.Add(result.CommandId);
            _sizes[result.CommandId] = json.Length;
            EnforceCaps();
            Interlocked.Exchange(ref _added, new(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();
        }
    }

    /// <summary>A delivered result offered again by the server: queue it to be posted again (the server's 409 then confirms it has it).</summary>
    public bool Requeue(Guid commandId)
    {
        lock (_gate)
        {
            if (!_delivered.ContainsKey(commandId)) return false;
            try { File.Move(DonePath(commandId), PendingPath(commandId), overwrite: true); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return false; }
            // The file is moved first: until it has been, the delivered copy is the only answer the offer can get.
            _delivered.Remove(commandId);
            _queue.Add(commandId);
            _sizes[commandId] = new FileInfo(PendingPath(commandId)).Length;
            Interlocked.Exchange(ref _added, new(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();
            return true;
        }
    }

    /// <summary>The oldest pending result and its bytes; null when none. A file that no longer reads back cleanly is dropped.</summary>
    public (Guid Id, byte[] Json)? Next()
    {
        lock (_gate)
        {
            while (_queue.Count > 0)
            {
                Guid id = _queue[0];
                byte[]? json = Read(PendingPath(id), id);
                if (json is not null) return (id, json);
                _log($"The stored result for {id} could not be read back and was discarded.");
                Forget(id);
                TryDelete(PendingPath(id));
            }
            return null;
        }
    }

    /// <summary>The server has the result (2xx, or 409 already stored); kept a while as delivered.</summary>
    public void Delivered(Guid commandId)
    {
        lock (_gate)
        {
            if (!_sizes.ContainsKey(commandId)) return;
            DateTimeOffset now = _clock.GetUtcNow();
            try
            {
                File.Move(PendingPath(commandId), DonePath(commandId), overwrite: true);
                File.SetLastWriteTimeUtc(DonePath(commandId), now.UtcDateTime);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // The result stays in the outbox rather than being dropped: the server taking it once more is
                // harmless, whereas losing it would leave the server without an answer it is waiting for.
                _log($"The delivered result for {commandId} could not be set aside ({e.GetType().Name}); it stays in the outbox.");
                return;
            }
            // Only now is it forgotten as pending and remembered as delivered.
            Forget(commandId);
            _delivered[commandId] = now;
            Prune(now);
        }
    }

    /// <summary>Completes when a result is added after this call; callers check <see cref="Next"/> first.</summary>
    public Task Added { get { lock (_gate) return _added.Task; } }

    private void Forget(Guid id) { _queue.Remove(id); _sizes.Remove(id); }

    private void EnforceCaps()
    {
        while (_queue.Count > MaxPending || (_queue.Count > 1 && _sizes.Values.Sum() > MaxPendingBytes))
        {
            Guid oldest = _queue[0];
            _log($"The result outbox is full; the oldest undelivered result ({oldest}) was dropped.");
            Forget(oldest);
            TryDelete(PendingPath(oldest));
        }
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var (id, _) in _delivered.Where(p => now - p.Value >= KeepDelivered).ToList()) { _delivered.Remove(id); TryDelete(DonePath(id)); }
        if (_delivered.Count <= MaxDone) return;
        foreach (var (id, _) in _delivered.OrderBy(p => p.Value).Take(_delivered.Count - MaxDone).ToList()) { _delivered.Remove(id); TryDelete(DonePath(id)); }
    }

    private static byte[]? Read(string path, Guid id)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > MaxResultBytes) return null;
            byte[] bytes = File.ReadAllBytes(path);
            if (!StrictJson.TryParse(bytes, MaxResultBytes, out JsonDocument? doc)) return null;
            using (doc)
            {
                JsonElement root = doc!.RootElement;
                if (!ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("result"), root)) return null;
                if (!root.TryGetProperty("commandId", out JsonElement c) || !c.TryGetGuid(out Guid inFile) || inFile != id) return null;
            }
            return bytes;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>Temporary file, flushed to the disk, then renamed over the target: a crash leaves the old file or the new one, never half of one.</summary>
    private static void WriteAtomic(string path, byte[] bytes)
    {
        string temp = path + ".tmp";
        using (var file = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            file.Write(bytes);
            file.Flush(flushToDisk: true);
        }
        File.Move(temp, path, overwrite: true);
    }

    private string PendingPath(Guid id) => Path.Combine(_pending, id.ToString("D") + ".json");
    private string DonePath(Guid id) => Path.Combine(_done, id.ToString("D") + ".json");

    private static Guid? Id(string name) =>
        name.EndsWith(".json", StringComparison.Ordinal) && Guid.TryParseExact(name[..^5], "D", out Guid id) && id.ToString("D") == name[..^5] ? id : null;

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
