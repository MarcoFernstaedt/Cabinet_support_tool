using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Server.Domain;

/// <summary>
/// A request to run one catalogued action on one cabinet.
///
/// There is no command, script or SQL column here by design. The action is an
/// enum resolved against a catalogue defined in code, and the parameters are
/// checked key-by-key against that catalogue's allow-list before anything is
/// ever handed to an agent.
/// </summary>
public class ActionRequest
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public CabinetActionType Action { get; set; }

    public Guid CabinetId { get; set; }
    public Cabinet? Cabinet { get; set; }

    public Guid RequestedByUserId { get; set; }
    public DateTime RequestedUtc { get; set; }

    /// <summary>Allow-listed keys only, serialised after validation.</summary>
    public string ParametersJson { get; set; } = "{}";

    public string Reason { get; set; } = string.Empty;
    public string? TicketReference { get; set; }

    public ActionRequestStatus Status { get; set; } = ActionRequestStatus.PendingApproval;

    /// <summary>
    /// Never equal to <see cref="RequestedByUserId"/>. The four-eyes rule is
    /// enforced with an explicit check at approval time, not merely by
    /// convention or by hiding the button.
    /// </summary>
    public Guid? ApprovedByUserId { get; set; }

    public DateTime? ApprovedUtc { get; set; }
    public DateTime? DispatchedUtc { get; set; }
    public DateTime? CompletedUtc { get; set; }

    public ActionResultStatus? ResultStatus { get; set; }
    public string? ResultOutput { get; set; }

    /// <summary>
    /// After this instant the action is dead. An approval nobody collected must
    /// not fire hours later against a cabinet whose state has moved on.
    /// </summary>
    public DateTime? ExpiresUtc { get; set; }

    /// <summary>Set when a Supervisor ran a disruptive action past its safety checks.</summary>
    public bool SafetyChecksOverridden { get; set; }

    /// <summary>Required whenever <see cref="SafetyChecksOverridden"/> is set.</summary>
    public string? OverrideReason { get; set; }
}
