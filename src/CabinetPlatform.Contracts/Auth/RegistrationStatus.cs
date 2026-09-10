using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Auth;

/// <summary>
/// Where an agent stands in the registration workflow.
/// </summary>
/// <remarks>
/// A newly registered agent lands in <see cref="Pending"/> and stays there
/// until a Supervisor approves it and assigns it a cabinet. Until then it has
/// no cabinet identity and reports nothing usable.
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RegistrationStatus
{
    /// <summary>Registered and waiting in the pending queue for a Supervisor decision.</summary>
    Pending = 1,

    /// <summary>Approved and assigned to a cabinet.</summary>
    Approved = 2,

    /// <summary>Rejected. The agent has no cabinet identity and will not be issued one.</summary>
    Rejected = 3,
}
