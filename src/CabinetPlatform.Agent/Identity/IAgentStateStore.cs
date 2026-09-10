namespace CabinetPlatform.Agent.Identity;

/// <summary>
/// Durable storage for <see cref="AgentState"/>.
/// </summary>
public interface IAgentStateStore
{
    AgentState Load();

    /// <summary>
    /// Applies a change and persists the result. The read and the write happen
    /// under one lock so two concurrent updates cannot lose each other.
    /// </summary>
    AgentState Update(Func<AgentState, AgentState> mutate);
}
