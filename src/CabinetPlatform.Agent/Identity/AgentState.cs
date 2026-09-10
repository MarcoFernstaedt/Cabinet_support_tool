using System.Text.Json.Serialization;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Agent.Identity;

/// <summary>
/// The small amount of state the agent must remember across restarts.
/// </summary>
public sealed record AgentState
{
    /// <summary>Hashed hardware identity, derived once and then stable.</summary>
    public string? MachineId { get; init; }

    /// <summary>Assigned by the server on approval. Null until then.</summary>
    public Guid? CabinetId { get; init; }

    /// <summary>Last registration outcome the server reported.</summary>
    public RegistrationStatus? RegistrationStatus { get; init; }

    public DateTimeOffset? LastRegistrationAttemptUtc { get; init; }

    /// <summary>
    /// An action that had started but had not reported a result when the agent
    /// last stopped. Its presence at startup is what stops the agent silently
    /// repeating a reboot or a service stop.
    /// </summary>
    public InFlightAction? InFlightAction { get; init; }

    /// <summary>
    /// True once the server has approved this cabinet. Until then the agent
    /// reports identity only.
    /// </summary>
    /// <remarks>
    /// Derived from the two fields above and never persisted. Writing it to
    /// the state file would put an approval flag in a file on the cabinet that
    /// looks editable, when approval is the server's decision alone.
    /// </remarks>
    [JsonIgnore]
    public bool IsApproved => CabinetId is not null
        && RegistrationStatus == Contracts.Auth.RegistrationStatus.Approved;
}

/// <summary>
/// The journal entry written before an action runs and cleared after its result
/// is recorded.
/// </summary>
public sealed record InFlightAction
{
    public required Guid RequestId { get; init; }

    public required ActionName Action { get; init; }

    public required DateTimeOffset StartedUtc { get; init; }
}
