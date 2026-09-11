namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// The server's answer to a registration attempt, and to an agent's later
/// checks on where that attempt stands.
/// </summary>
public sealed record RegistrationResponse
{
    /// <summary>Where the agent stands in the registration workflow.</summary>
    public required RegistrationStatus Status { get; init; }

    /// <summary>
    /// Cabinet assigned to the agent, present only once
    /// <see cref="Status"/> is <see cref="RegistrationStatus.Approved"/>.
    /// While pending or rejected it is <see langword="null"/>, and the agent
    /// has no cabinet identity to report under.
    /// </summary>
    public Guid? CabinetId { get; init; }

    /// <summary>
    /// How long the agent should wait before asking again. It lets the server
    /// pace a fleet of pending agents centrally rather than relying on each
    /// one's local configuration.
    /// </summary>
    public required int RetryAfterSeconds { get; init; }
}
