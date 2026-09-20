using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// Support roles recognised by the platform.
/// </summary>
/// <remarks>
/// A role is a claim about a user, not a decision. The server maps roles to
/// what may be done; the console never enforces its own rules and neither
/// does the agent.
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum Role
{
    /// <summary>First-line support label. Shares support capabilities with Tier 2.</summary>
    Tier1 = 1,

    /// <summary>Second-line support label. Does not grant additional operations.</summary>
    Tier2 = 2,

    /// <summary>
    /// Supervisor: approves pending agents, assigns cabinets, and provides the
    /// account administration unavailable to support tiers. Action safety gates
    /// remain independent of tier labels.
    /// </summary>
    Supervisor = 3,
}
