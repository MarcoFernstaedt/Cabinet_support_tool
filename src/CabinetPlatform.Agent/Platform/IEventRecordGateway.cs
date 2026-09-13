using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Streaming local native record boundary; implementations must be newest first.</summary>
public interface IEventRecordGateway
{
    IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token);
}
