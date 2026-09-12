using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Transport;

/// <summary>How a check-in was received.</summary>
public enum CheckInOutcome
{
    /// <summary>The server accepted the payload.</summary>
    Accepted = 1,

    /// <summary>
    /// The server knows this cabinet but has not approved it. The agent keeps
    /// trying on its normal cadence; a human has to approve it.
    /// </summary>
    NotApproved = 2,

    /// <summary>
    /// The server has never seen this machine id. The agent registers again.
    /// </summary>
    NotRegistered = 3,

    /// <summary>The server could not be reached or returned an error.</summary>
    Failed = 4,

    /// <summary>
    /// The server rejected the payload as malformed. Retrying an identical
    /// payload cannot succeed, so it is dropped rather than spooled forever.
    /// </summary>
    Rejected = 5,
}

/// <summary>Result of a check-in attempt.</summary>
public sealed record CheckInResult
{
    public required CheckInOutcome Outcome { get; init; }

    /// <summary>Returned when the server approves the cabinet on this call.</summary>
    public Guid? CabinetId { get; init; }

    public string? Detail { get; init; }

    /// <summary>Whether the payload is worth keeping for a later attempt.</summary>
    public bool ShouldRetry => Outcome is CheckInOutcome.Failed;
}

/// <summary>
/// Every call the agent makes to the server.
/// </summary>
/// <remarks>
/// All of it is outbound. The agent never listens on a port, so there is no
/// inbound surface on a cabinet for this interface to describe.
/// </remarks>
public interface IServerClient
{
    Task<RegistrationResponse?> RegisterAsync(RegistrationRequest request, CancellationToken cancellationToken);

    /// <param name="payload">The sample.</param>
    /// <param name="tier">Which tier it belongs to; the server routes on it.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    Task<CheckInResult> CheckInAsync(
        CheckInPayload payload, CheckInTier tier, CancellationToken cancellationToken);

    /// <summary>
    /// Polls for actions the server has approved and not yet dispatched.
    /// </summary>
    Task<IReadOnlyList<ActionRequestDto>> GetPendingActionsAsync(
        Guid cabinetId,
        CancellationToken cancellationToken);

    /// <summary>Reports an action's outcome. Returns false if it did not land.</summary>
    Task<bool> ReportActionResultAsync(ActionResultDto result, CancellationToken cancellationToken);
}
