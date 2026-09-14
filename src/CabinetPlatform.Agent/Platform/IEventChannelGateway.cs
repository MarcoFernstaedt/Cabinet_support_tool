using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Read-only access to local registered channels, separate from record collection.</summary>
public interface IEventChannelGateway
{
    /// <summary>Enumerates native names. The caller disposes the enumerator when its budget is exhausted.</summary>
    IEnumerable<string> GetChannelNames(CancellationToken cancellationToken);

    /// <summary>Checks current read access without returning records or changing configuration.</summary>
    EventChannelAccess Probe(string channelName, CancellationToken cancellationToken);
}
