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
    /// <summary>First-line support: read telemetry and perform non-disruptive actions.</summary>
    Tier1 = 1,

    /// <summary>Second-line support: everything Tier 1 may do, plus service-level actions.</summary>
    Tier2 = 2,

    /// <summary>
    /// Supervisor: approves pending agents, assigns cabinets, and provides the
    /// second approval that disruptive actions require.
    /// </summary>
    Supervisor = 3,
}
