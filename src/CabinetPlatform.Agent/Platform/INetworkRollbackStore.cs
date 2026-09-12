using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// A network configuration change that has been applied but not yet confirmed.
/// </summary>
public sealed record NetworkRollback
{
    /// <summary>The action that applied the change.</summary>
    public required Guid ActionRequestId { get; init; }

    /// <summary>The configuration as it was before.</summary>
    public required AdapterConfiguration Previous { get; init; }

    /// <summary>UTC instant the change was applied.</summary>
    public required DateTimeOffset AppliedUtc { get; init; }
}

/// <summary>
/// Holds an unconfirmed network change on disk, so a restart cannot lose it.
/// </summary>
/// <remarks>
/// <para>
/// This is the part of confirm-or-revert that covers the worst case. The
/// executor's own wait handles a change that simply does not work. What it
/// cannot handle is the machine restarting between applying and confirming —
/// and a cabinet that reboots mid-change is not a hypothetical, because some of
/// these changes prompt Windows to want one.
/// </para>
/// <para>
/// A file rather than memory, and checked at startup before the agent does
/// anything else. An agent that comes back holding an unconfirmed rollback
/// reverts first and asks questions afterwards: the previous configuration is
/// known to have worked, and the new one is not.
/// </para>
/// </remarks>
public interface INetworkRollbackStore
{
    /// <summary>Records a rollback, replacing any it already held.</summary>
    /// <param name="rollback">The configuration to restore, and when it was replaced.</param>
    void Write(NetworkRollback rollback);

    /// <summary>Reads the pending rollback, or null when there is none.</summary>
    NetworkRollback? Read();

    /// <summary>Removes the pending rollback. Called once a change is confirmed or undone.</summary>
    void Clear();
}

/// <summary>File-backed implementation, in the agent's state directory.</summary>
public sealed class FileNetworkRollbackStore : INetworkRollbackStore
{
    private readonly string _path;
    private readonly ILogger<FileNetworkRollbackStore> _logger;
    private readonly object _gate = new();

    /// <summary>Creates the store.</summary>
    /// <param name="options">Agent configuration, for the state directory.</param>
    /// <param name="logger">Diagnostic log.</param>
    public FileNetworkRollbackStore(
        IOptions<AgentOptions> options, ILogger<FileNetworkRollbackStore> logger)
    {
        AgentOptions value = options.Value;

        _path = Path.Combine(
            Path.GetFullPath(value.StateDirectory), value.Actions.NetworkRollbackFileName);

        _logger = logger;
    }

    /// <inheritdoc />
    public void Write(NetworkRollback rollback)
    {
        lock (_gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            // Written to a temporary file and moved into place, so a machine
            // losing power mid-write leaves either the old rollback or the new
            // one, never half of either.
            string temporary = _path + ".tmp";

            File.WriteAllText(temporary, JsonSerializer.Serialize(rollback, AgentJson.SerializerOptions));
            File.Move(temporary, _path, overwrite: true);
        }

        _logger.LogInformation(
            "A network rollback for adapter '{AdapterId}' was written before applying a change.",
            rollback.Previous.AdapterId);
    }

    /// <inheritdoc />
    public NetworkRollback? Read()
    {
        lock (_gate)
        {
            if (!File.Exists(_path))
            {
                return null;
            }

            try
            {
                return JsonSerializer.Deserialize<NetworkRollback>(
                    File.ReadAllText(_path), AgentJson.SerializerOptions);
            }
            catch (Exception e) when (e is JsonException or IOException)
            {
                // An unreadable rollback cannot be applied, and leaving the file
                // in place would mean trying again on every start. It is
                // reported loudly, because a cabinet whose rollback was lost may
                // be holding a configuration nobody confirmed.
                _logger.LogError(
                    e,
                    "The pending network rollback at {Path} could not be read. If a network change " +
                    "was applied and not confirmed, this cabinet's configuration needs checking.",
                    _path);

                return null;
            }
        }
    }

    /// <inheritdoc />
    public void Clear()
    {
        lock (_gate)
        {
            if (!File.Exists(_path))
            {
                return;
            }

            try
            {
                File.Delete(_path);
            }
            catch (IOException e)
            {
                _logger.LogWarning(e, "The pending network rollback at {Path} could not be removed.", _path);
            }
        }
    }
}
