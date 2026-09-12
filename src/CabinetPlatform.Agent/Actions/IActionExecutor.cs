using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Actions;

/// <summary>What an executor did.</summary>
public sealed record ActionOutcome
{
    public required ActionStatus Status { get; init; }

    public string? Output { get; init; }

    /// <summary>
    /// Structured data the action collected, as JSON, for the on-demand
    /// collectors. Null for every other action. It is data the agent read,
    /// never anything the server executes.
    /// </summary>
    public string? CollectedData { get; init; }

    public static ActionOutcome Succeeded(string? output = null)
        => new() { Status = ActionStatus.Succeeded, Output = output };

    public static ActionOutcome Failed(string reason)
        => new() { Status = ActionStatus.Failed, Output = reason };

    /// <summary>
    /// The agent refused. Used for a parameter that fails the agent's own
    /// validation, a target outside its allow-list, or a safety condition such
    /// as somebody being logged on.
    /// </summary>
    public static ActionOutcome Denied(string reason)
        => new() { Status = ActionStatus.Denied, Output = reason };

    public static ActionOutcome TimedOut(string reason)
        => new() { Status = ActionStatus.TimedOut, Output = reason };

    /// <summary>An on-demand collector succeeded and is returning what it read.</summary>
    /// <param name="output">One line a person reads.</param>
    /// <param name="collectedData">The records themselves, as JSON.</param>
    public static ActionOutcome Collected(string output, string collectedData)
        => new() { Status = ActionStatus.Succeeded, Output = output, CollectedData = collectedData };
}

/// <summary>
/// One action's implementation.
/// </summary>
/// <remarks>
/// <para>
/// There is exactly one executor per <see cref="ActionName"/> and no generic
/// executor, no interpreter and no fallback. An action the agent has no
/// compiled-in executor for is denied; there is no path by which the server can
/// describe work for the agent to perform rather than name it.
/// </para>
/// <para>
/// Nothing implementing this interface actuates cabinet hardware. There is no
/// drawer, lock or cubie executor in this build.
/// </para>
/// </remarks>
public interface IActionExecutor
{
    /// <summary>The single action this executor handles.</summary>
    ActionName Action { get; }

    /// <summary>
    /// Validates the request against the agent's own rules and performs it.
    /// </summary>
    /// <remarks>
    /// Implementations re-validate every parameter even though the server has
    /// already done so. That is not redundancy for its own sake: it is what
    /// keeps a compromised or simply buggy server from steering the agent
    /// outside its catalog.
    /// </remarks>
    Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken);
}
