using System.Text.Json;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Connectivity;

/// <summary>Small atomic interval outbox. Bounds are compiled, not remotely configurable.</summary>
public sealed class ConnectivitySpool
{
    public const int MaximumFiles = 8192;
    public const long MaximumBytes = 8 * 1024 * 1024;
    private readonly string _directory;
    private readonly object _gate = new();

    public ConnectivitySpool(string directory)
    {
        _directory = Path.GetFullPath(directory);
        Directory.CreateDirectory(_directory);
        // Interrupted atomic writes have never been acknowledged and are not valid frames.
        foreach (var file in new DirectoryInfo(_directory).EnumerateFiles("*.tmp")) file.Delete();
    }

    public bool Enqueue(ConnectivitySummary summary, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (summary.Id == Guid.Empty || summary.FirstObservedUtc < now.AddDays(-14) || summary.LastObservedUtc > now) return false;
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(summary, AgentJson.SerializerOptions);
            if (bytes.Length > 4096) return false;
            string path = PathFor(summary.Id), temporary = path + ".tmp";
            try
            {
                Prune(now);
                using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes);
                    stream.Flush(flushToDisk: true);
                }
                File.Move(temporary, path, overwrite: true);
                Prune(now);
                return File.Exists(path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }

    public IReadOnlyList<ConnectivitySummary> Peek(DateTimeOffset now)
    {
        lock (_gate)
        {
            Prune(now);
            return ReadValid(now).OrderBy(x => x.Summary.FirstObservedUtc).ThenBy(x => x.Summary.Id)
                .Take(16).Select(x => x.Summary).ToArray();
        }
    }

    public void Acknowledge(IEnumerable<Guid> ids)
    {
        lock (_gate)
        {
            foreach (var id in ids) File.Delete(PathFor(id));
        }
    }

    private string PathFor(Guid id) => Path.Combine(_directory, $"{id:N}.json");

    private List<(FileInfo File, ConnectivitySummary Summary)> ReadValid(DateTimeOffset now)
    {
        var results = new List<(FileInfo, ConnectivitySummary)>();
        foreach (var file in new DirectoryInfo(_directory).EnumerateFiles("*.json"))
        {
            ConnectivitySummary? summary = null;
            if (file.Length <= 4096 && Guid.TryParseExact(Path.GetFileNameWithoutExtension(file.Name), "N", out var id))
            {
                try
                {
                    using var stream = file.OpenRead();
                    summary = JsonSerializer.Deserialize<ConnectivitySummary>(stream, AgentJson.SerializerOptions);
                    if (summary?.Id != id) summary = null;
                }
                catch (JsonException) { /* An incomplete/corrupt frame cannot be transmitted. */ }
            }
            if (summary is null || summary.FirstObservedUtc < now.AddDays(-14) || summary.LastObservedUtc > now)
                file.Delete();
            else results.Add((file, summary));
        }
        return results;
    }

    private void Prune(DateTimeOffset now)
    {
        var files = ReadValid(now).OrderBy(x => x.Summary.FirstObservedUtc).ThenBy(x => x.Summary.Id).ToArray();
        long bytes = files.Sum(x => x.File.Length);
        int count = files.Length;
        foreach (var item in files)
        {
            if (count <= MaximumFiles && bytes <= MaximumBytes) break;
            bytes -= item.File.Length;
            item.File.Delete();
            count--;
        }
    }
}
