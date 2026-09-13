using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Identity;

/// <summary>
/// Persists agent state as a single JSON file under the configured state
/// directory.
/// </summary>
/// <remarks>
/// Writes go to a temporary file that is then moved over the target, so a
/// temporary file is flushed before replacement. Filesystem/power-loss guarantees
/// still require platform validation. Unreadable state stops operation and stays
/// in place for operator recovery; it is never mistaken for empty state.
/// </remarks>
public sealed class FileAgentStateStore : IAgentStateStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
    };

    private readonly string _statePath;
    private readonly ILogger<FileAgentStateStore> _logger;
    private readonly object _gate = new();
    private AgentState? _cached;

    public FileAgentStateStore(IOptions<AgentOptions> options, ILogger<FileAgentStateStore> logger)
    {
        _logger = logger;

        var directory = Path.GetFullPath(options.Value.StateDirectory);
        Directory.CreateDirectory(directory);
        _statePath = Path.Combine(directory, "agent-state.json");
    }

    public AgentState Load()
    {
        lock (_gate)
        {
            return _cached ??= ReadFromDisk();
        }
    }

    public AgentState Update(Func<AgentState, AgentState> mutate)
    {
        lock (_gate)
        {
            var current = _cached ??= ReadFromDisk();
            var updated = mutate(current);
            WriteToDisk(updated);
            _cached = updated;
            return updated;
        }
    }

    private AgentState ReadFromDisk()
    {
        if (!File.Exists(_statePath))
        {
            return new AgentState();
        }

        try
        {
            var json = File.ReadAllText(_statePath);
            return JsonSerializer.Deserialize<AgentState>(json, SerializerOptions)
                ?? throw new JsonException("Agent state cannot be null.");
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            _logger.LogError(
                e,
                "Agent state at {StatePath} was unreadable. Refusing to operate.",
                _statePath);

            // Keep the original in place: moving it would make the next restart
            // mistake a lost journal for first registration.
            throw;
        }
    }

    private void WriteToDisk(AgentState state)
    {
        var temporaryPath = _statePath + ".tmp";

        try
        {
            using (var stream = new FileStream(temporaryPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, state, SerializerOptions);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, _statePath, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogError(e, "Failed to persist agent state to {StatePath}.", _statePath);

            try
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException)
            {
                // Preserve the original persistence error.
            }

            throw;
        }
    }

}
