using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>A monitor's small remembered state (bookmarks, last readings), kept on disk so a restart does not re-report.</summary>
/// <param name="path">Where the state is kept; null keeps it in memory (tests).</param>
/// <param name="critical">True for state the agent must not lose (the safety net's pending changes): a file that is there but cannot be read is not an empty state.</param>
public sealed class StateFile<T> where T : class, new()
{
    private const int MaxBytes = 1024 * 1024;
    private readonly string? _path;
    private readonly bool _critical;
    private string? _memory; // without a file (tests), the state lives here

    public StateFile(string? path, bool critical = false)
    {
        _path = path;
        _critical = critical;
    }

    /// <summary>True when the last <see cref="Load"/> found a file it could not read, so what it returned is not what was saved.</summary>
    public bool LastLoadFailed { get; private set; }

    /// <summary>
    /// The saved state, or a fresh one when there is none or it cannot be read (it is only a memory, never trusted input).
    /// State that matters keeps the copy from before the last save instead of reporting a fresh, empty one, and says so.
    /// </summary>
    public T Load()
    {
        LastLoadFailed = false;
        if (_path is null) return _memory is null ? new T() : JsonSerializer.Deserialize<T>(_memory, ContractJson.Options)!;
        if (!File.Exists(_path)) return new T();
        if (Read(_path) is { } state) return state;
        // The file is there and does not read back, so nothing here is trustworthy: for state that matters the copy
        // kept before the last save stands in, and LastLoadFailed says the answer is not the saved one.
        LastLoadFailed = true;
        return _critical && Read(_path + ".previous") is { } previous ? previous : new T();
    }

    public void Save(T state)
    {
        string json = JsonSerializer.Serialize(state, ContractJson.Options);
        if (_path is null)
        {
            _memory = json;
            return;
        }
        // The version on disk is kept first, so a write that is cut short cannot take the state with it.
        if (_critical && File.Exists(_path))
        {
            try { File.Copy(_path, _path + ".previous", overwrite: true); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Best effort: the copy is only there for the case where the file itself cannot be read.
            }
        }
        AtomicFile.Write(_path, json);
    }

    private static T? Read(string path)
    {
        try
        {
            if (!File.Exists(path) || new FileInfo(path).Length > MaxBytes) return null;
            return JsonSerializer.Deserialize<T>(File.ReadAllBytes(path), ContractJson.Options) ?? new T();
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException or NotSupportedException) { return null; }
    }
}
