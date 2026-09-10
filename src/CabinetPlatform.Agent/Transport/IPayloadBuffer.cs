using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Transport;

/// <summary>A payload held on disk while the server is unreachable.</summary>
public sealed record BufferedPayload
{
    public required string Id { get; init; }

    public required CheckInPayload Payload { get; init; }
}

/// <summary>
/// The offline spool for check-ins that could not be delivered.
/// </summary>
public interface IPayloadBuffer
{
    /// <summary>
    /// Spools a payload, then prunes the spool back within its configured
    /// bounds. Returns false when the payload could not be written at all.
    /// </summary>
    bool Enqueue(CheckInPayload payload);

    /// <summary>
    /// Reads up to <paramref name="maximumCount"/> of the oldest spooled
    /// payloads, oldest first, so an outage replays in the order it happened.
    /// </summary>
    IReadOnlyList<BufferedPayload> PeekOldest(int maximumCount);

    /// <summary>Removes a payload that has been delivered.</summary>
    void Remove(string id);

    /// <summary>Number of payloads currently spooled.</summary>
    int Count { get; }
}
