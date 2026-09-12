using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Transport;

/// <summary>A payload held on disk while the server is unreachable.</summary>
public sealed record BufferedPayload
{
    /// <summary>Identifies the spooled file, for removal once delivered.</summary>
    public required string Id { get; init; }

    /// <summary>The payload itself.</summary>
    public required CheckInPayload Payload { get; init; }

    /// <summary>
    /// The tier it was collected for, so a late delivery is still stored as
    /// what it is. Replaying an inventory sample as a heartbeat would quietly
    /// discard the inventory.
    /// </summary>
    public required CheckInTier Tier { get; init; }
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
    /// <param name="payload">The payload to spool.</param>
    /// <param name="tier">The tier it was collected for.</param>
    bool Enqueue(CheckInPayload payload, CheckInTier tier);

    /// <summary>
    /// Reads up to <paramref name="maximumCount"/> of the oldest spooled
    /// payloads, oldest first, so an outage replays in the order it happened.
    /// </summary>
    /// <param name="maximumCount">How many to read.</param>
    IReadOnlyList<BufferedPayload> PeekOldest(int maximumCount);

    /// <summary>Removes a payload that has been delivered.</summary>
    /// <param name="id">The spooled file's identifier.</param>
    void Remove(string id);

    /// <summary>Number of payloads currently spooled.</summary>
    int Count { get; }
}
