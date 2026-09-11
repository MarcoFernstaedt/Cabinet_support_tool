using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// Where a requested action stands in its lifecycle on the server.
/// </summary>
/// <remarks>
/// This is the server's view of a request. It is distinct from
/// <see cref="ActionStatus"/>, which is how the <em>agent</em> says an action
/// ended: a request can be <see cref="Completed"/> here while the agent's own
/// outcome was <see cref="ActionStatus.Failed"/>. Folding the two together
/// would lose the difference between "we never dispatched it" and "it ran and
/// failed".
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ActionRequestStatus
{
    /// <summary>Raised and waiting for a second person to approve it.</summary>
    PendingApproval = 1,

    /// <summary>Approved and waiting to be collected by the agent.</summary>
    Approved = 2,

    /// <summary>Refused by an approver. It never reaches the agent.</summary>
    Denied = 3,

    /// <summary>Handed to the agent and awaiting an outcome.</summary>
    Dispatched = 4,

    /// <summary>The agent reported an outcome. See the result status for what it was.</summary>
    Completed = 5,

    /// <summary>Not collected before its expiry. It will never be dispatched.</summary>
    Expired = 6,

    /// <summary>Withdrawn before dispatch, or its catalog entry was retired.</summary>
    Cancelled = 7,
}
