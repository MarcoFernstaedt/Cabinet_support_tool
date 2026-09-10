using CabinetPlatform.Agent.Identity;

namespace CabinetPlatform.Agent.Tests.TestSupport;

/// <summary>Agent state held in memory, for tests that do not exercise persistence.</summary>
internal sealed class InMemoryAgentStateStore : IAgentStateStore
{
    private AgentState _state;

    public InMemoryAgentStateStore(AgentState? initial = null) => _state = initial ?? new AgentState();

    public int UpdateCount { get; private set; }

    public AgentState Load() => _state;

    public AgentState Update(Func<AgentState, AgentState> mutate)
    {
        UpdateCount++;
        _state = mutate(_state);
        return _state;
    }
}
