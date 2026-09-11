namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// What the server tells an agent after a check-in.
/// </summary>
/// <remarks>
/// This is also how an approved agent learns its own cabinet identity: the
/// server issues <see cref="CabinetId"/> on every accepted check-in, so an
/// agent that was approved while offline picks it up on its next successful
/// call without a separate round trip.
/// </remarks>
public sealed record CheckInResponse
{
    /// <summary>Whether the sample was accepted.</summary>
    public required bool Accepted { get; init; }

    /// <summary>
    /// The cabinet this machine is assigned to. An agent stores it and reports
    /// under it from then on.
    /// </summary>
    public required Guid CabinetId { get; init; }

    /// <summary>UTC instant the server received the sample.</summary>
    public required DateTimeOffset ReceivedUtc { get; init; }

    /// <summary>
    /// True when this exact sample had already been stored. Agents retry over
    /// flaky clinic networks, and a retried sample is acknowledged rather than
    /// stored twice.
    /// </summary>
    public required bool WasDuplicate { get; init; }

    /// <summary>
    /// True when the full tier was accepted but its inventory matched the
    /// version already in force, so nothing new was written. Not a failure:
    /// an unchanged inventory writing nothing is the point of the tier.
    /// </summary>
    public required bool InventoryUnchanged { get; init; }

    /// <summary>Seconds until the agent should send its next heartbeat, before jitter.</summary>
    public required int NextHeartbeatSeconds { get; init; }

    /// <summary>Seconds until the agent should send its next full check-in, before jitter.</summary>
    public required int NextFullCheckInSeconds { get; init; }

    /// <summary>Set when at least one approved action is waiting to be collected.</summary>
    public required bool HasPendingActions { get; init; }
}
