namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// What an agent sends the first time it contacts the server, to enter the
/// pending queue.
/// </summary>
/// <remarks>
/// Registration asks to be recognised; it does not confer identity. The agent
/// receives no cabinet assignment until a Supervisor approves it.
/// </remarks>
public sealed record RegistrationRequest
{
    /// <summary>
    /// Stable hardware-derived machine identifier, hashed. It is what the
    /// pending queue keys on, so a machine that is renamed or re-addressed is
    /// still the same machine.
    /// </summary>
    public required string MachineId { get; init; }

    /// <summary>Current hostname, shown to the approving Supervisor as a human-readable hint.</summary>
    public required string Hostname { get; init; }

    /// <summary>Operating system version reported by the machine.</summary>
    public required string OsVersion { get; init; }

    /// <summary>Version of the agent requesting registration.</summary>
    public required string AgentVersion { get; init; }
}
