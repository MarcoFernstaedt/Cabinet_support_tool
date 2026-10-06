using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>A monitor's small remembered state (bookmarks, last readings), kept on disk so a restart does not re-report.</summary>
public sealed class StateFile<T> where T : class, new()
{
    private const int MaxBytes = 1024 * 1024;
    private readonly string? _path;
    private string? _memory; // without a file (tests), the state lives here

    public StateFile(string? path) => _path = path;

    /// <summary>The saved state, or a fresh one when there is none or it cannot be read (it is only a memory, never trusted input).</summary>
    public T Load()
    {
        if (_path is null) return _memory is null ? new T() : JsonSerializer.Deserialize<T>(_memory, ContractJson.Options)!;
        if (!File.Exists(_path)) return new T();
        try
        {
            if (new FileInfo(_path).Length > MaxBytes) return new T();
            return JsonSerializer.Deserialize<T>(File.ReadAllBytes(_path), ContractJson.Options) ?? new T();
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException or NotSupportedException) { return new T(); }
    }

    public void Save(T state)
    {
        string json = JsonSerializer.Serialize(state, ContractJson.Options);
        if (_path is null) _memory = json;
        else AtomicFile.Write(_path, json);
    }
}
