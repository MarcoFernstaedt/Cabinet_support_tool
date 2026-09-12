using System.Text.Json.Serialization;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

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
    /// Requests this agent has already carried out, newest first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The agent is idempotent per request id, and this is how. An action that
    /// arrives a second time — a poll that raced a result report, a retry over
    /// a flaky link — is answered from here with the outcome it already had,
    /// rather than performed again. Rebooting a cabinet twice because the first
    /// acknowledgement was lost is not an acceptable failure mode.
    /// </para>
    /// <para>
    /// Bounded, because this file is read and written on every action and the
    /// window that matters is minutes. It survives restarts, which is when a
    /// duplicate is most likely.
    /// </para>
    /// </remarks>
    public IReadOnlyList<CompletedAction> CompletedActions { get; init; } = Array.Empty<CompletedAction>();

    /// <summary>
    /// The update install this cabinet is due to perform, or null when there is
    /// none.
    /// </summary>
    /// <remarks>
    /// On disk because the case that matters is the one where the machine
    /// reboots between scheduling and execution. A schedule held only in a
    /// running process is exactly the schedule that is not there when it is
    /// needed.
    /// </remarks>
    public ScheduledUpdateInstall? ScheduledUpdate { get; init; }

    /// <summary>
    /// Install outcomes this agent has not yet managed to report.
    /// </summary>
    /// <remarks>
    /// Kept until a check-in carrying them is accepted. What a machine actually
    /// did with an install is the fact the whole scheduling feature exists to
    /// establish, and losing it to a network outage would leave the fleet
    /// believing it is patched when it is not.
    /// </remarks>
    public IReadOnlyList<UpdateInstallOutcome> PendingUpdateOutcomes { get; init; }
        = Array.Empty<UpdateInstallOutcome>();

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
    /// <summary>The request being carried out.</summary>
    public required Guid RequestId { get; init; }

    /// <summary>What it asked for.</summary>
    public required ActionName Action { get; init; }

    /// <summary>When the agent began.</summary>
    public required DateTimeOffset StartedUtc { get; init; }
}

/// <summary>One request this agent has already carried out, and how it ended.</summary>
public sealed record CompletedAction
{
    /// <summary>The request that was carried out.</summary>
    public required Guid RequestId { get; init; }

    /// <summary>What it asked for.</summary>
    public required ActionName Action { get; init; }

    /// <summary>How it ended.</summary>
    public required ActionStatus Status { get; init; }

    /// <summary>When the agent finished.</summary>
    public required DateTimeOffset CompletedAtUtc { get; init; }

    /// <summary>The outcome detail reported at the time.</summary>
    public string? Output { get; init; }
}

/// <summary>
/// An update install this cabinet is due to perform.
/// </summary>
/// <remarks>
/// Specific updates and a UTC instant. Not "everything applicable", because
/// that would install whatever has become applicable between the rep choosing
/// and the machine acting; and not a wall-clock time, because a wall-clock time
/// written down in March means a different instant in April.
/// </remarks>
public sealed record ScheduledUpdateInstall
{
    /// <summary>The action request that asked for it.</summary>
    public required Guid ActionRequestId { get; init; }

    /// <summary>Who asked, recorded so the outcome can be attributed.</summary>
    public required Guid RequestedByUserId { get; init; }

    /// <summary>When the install is due, in UTC.</summary>
    public required DateTimeOffset ScheduledForUtc { get; init; }

    /// <summary>The updates to install, by Windows Update identifier.</summary>
    public IReadOnlyList<string> UpdateIds { get; init; } = Array.Empty<string>();

    /// <summary>Whether the install may restart the cabinet when it needs to.</summary>
    public required bool RebootIfRequired { get; init; }
}
