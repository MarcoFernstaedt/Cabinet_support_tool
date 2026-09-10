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
/// machine losing power mid-write leaves either the old state or the new one
/// and never a truncated file. State that fails to parse is treated as absent
/// and the file is kept aside for inspection rather than silently deleted.
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
            return JsonSerializer.Deserialize<AgentState>(json, SerializerOptions) ?? new AgentState();
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            _logger.LogError(
                e,
                "Agent state at {StatePath} was unreadable. Starting from empty state; " +
                "the cabinet will re-register and wait for approval again.",
                _statePath);

            TryQuarantine();
            return new AgentState();
        }
    }

    private void WriteToDisk(AgentState state)
    {
        var temporaryPath = _statePath + ".tmp";

        try
        {
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(state, SerializerOptions));
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
            catch (IOException)
            {
                // Nothing further to do; the next write will overwrite it.
            }
        }
    }

    private void TryQuarantine()
    {
        try
        {
            var quarantinePath = $"{_statePath}.corrupt-{DateTime.UtcNow:yyyyMMddHHmmss}";
            File.Move(_statePath, quarantinePath, overwrite: false);
            _logger.LogWarning("Unreadable state file preserved at {QuarantinePath}.", quarantinePath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(e, "Could not preserve the unreadable state file.");
        }
    }
}
