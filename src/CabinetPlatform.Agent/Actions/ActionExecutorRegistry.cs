using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Actions;

/// <summary>
/// Resolves an <see cref="ActionName"/> to the one executor that implements it.
/// </summary>
/// <remarks>
/// <para>
/// This class is the allow-list in force. Executors are registered in DI and
/// indexed here by their own declared <see cref="IActionExecutor.Action"/>. A
/// name with no entry resolves to nothing, and the dispatcher denies it.
/// </para>
/// <para>
/// There is deliberately no default branch, no "closest match" and no way to
/// supply an executor at run time. Adding an action to this agent means writing
/// a class and shipping a build, which is the property that makes the catalog
/// auditable.
/// </para>
/// </remarks>
public sealed class ActionExecutorRegistry
{
    private readonly IReadOnlyDictionary<ActionName, IActionExecutor> _executors;

    public ActionExecutorRegistry(IEnumerable<IActionExecutor> executors, ILogger<ActionExecutorRegistry> logger)
    {
        var indexed = new Dictionary<ActionName, IActionExecutor>();

        foreach (var executor in executors)
        {
            if (indexed.TryGetValue(executor.Action, out var existing))
            {
                // Two executors claiming one action would make which one runs
                // depend on registration order. That is not a thing to discover
                // in production on a dispensing cabinet.
                throw new InvalidOperationException(
                    $"Both {existing.GetType().Name} and {executor.GetType().Name} claim to implement " +
                    $"{executor.Action}. Exactly one executor may implement each action.");
            }

            indexed[executor.Action] = executor;
        }

        _executors = indexed;

        var unimplemented = Enum.GetValues<ActionName>()
            .Where(action => !indexed.ContainsKey(action))
            .ToArray();

        if (unimplemented.Length > 0)
        {
            // Not fatal: an agent that implements part of the catalog is still
            // useful, and it denies the rest honestly rather than guessing.
            logger.LogWarning(
                "No executor is registered for {UnimplementedActions}. Requests for those actions will be denied.",
                string.Join(", ", unimplemented));
        }

        logger.LogInformation(
            "Action catalog: {ImplementedCount} of {TotalCount} actions have an executor.",
            indexed.Count,
            Enum.GetValues<ActionName>().Length);
    }

    /// <summary>The actions this build can actually perform.</summary>
    public IReadOnlyCollection<ActionName> ImplementedActions => _executors.Keys.ToArray();

    /// <summary>
    /// Finds the executor for an action.
    /// </summary>
    /// <returns>Null when nothing implements it, which the caller denies.</returns>
    public IActionExecutor? Resolve(ActionName action)
        => _executors.TryGetValue(action, out var executor) ? executor : null;
}
