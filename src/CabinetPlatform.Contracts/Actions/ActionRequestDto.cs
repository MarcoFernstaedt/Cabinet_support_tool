namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// A request for an agent to perform one action from the allow-list, together
/// with the justification that will be audited alongside it.
/// </summary>
/// <remarks>
/// <para>
/// There is no field here for a command line, a script body or SQL text, and
/// none will be added. If a future requirement appears to need one, that
/// requirement is wrong.
/// </para>
/// <para>
/// A request is a request, not a permission. The server alone decides whether
/// it is allowed, and records the decision either way.
/// </para>
/// </remarks>
public sealed record ActionRequestDto
{
    /// <summary>
    /// Identifier for this request. The agent echoes it back as
    /// <see cref="ActionResultDto.RequestId"/>, and it ties request, result
    /// and audit record together.
    /// </summary>
    public required Guid Id { get; init; }

    /// <summary>The action to perform, drawn from the fixed catalog.</summary>
    public required ActionName Action { get; init; }

    /// <summary>Cabinet the action targets.</summary>
    public required Guid CabinetId { get; init; }

    /// <summary>
    /// Named operands for the action, for example the service name for
    /// <see cref="ActionName.RestartService"/>. Values name targets; they are
    /// never command text, arguments to a shell, or anything an agent
    /// interprets as executable. Each action validates its own operands
    /// server-side before dispatch.
    /// </summary>
    public IReadOnlyDictionary<string, string> Parameters { get; init; }
        = new Dictionary<string, string>();

    /// <summary>Why the action is being requested, recorded in the audit trail.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket this action belongs to, or <see langword="null"/> when there is none.</summary>
    public string? TicketReference { get; init; }

    /// <summary>Identifier of the user who requested the action.</summary>
    public required string RequestedByUserId { get; init; }

    /// <summary>UTC instant the request was raised.</summary>
    public required DateTimeOffset RequestedUtc { get; init; }
}
