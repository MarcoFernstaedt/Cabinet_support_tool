using System.Text.Json;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// The single serializer configuration the agent uses, for the wire and for the
/// offline spool alike.
/// </summary>
/// <remarks>
/// <para>
/// It is the shared contract convention and nothing else. A second set of
/// settings that merely looked equivalent is how an agent and a server drift
/// into private dialects: the payload still parses, the check-in still returns
/// 200, and one field quietly stops arriving. Pointing at the shared instance
/// makes that class of bug impossible rather than unlikely.
/// </para>
/// <para>
/// Using one instance matters for the spool too: a payload written during an
/// outage is read back by a later run of the agent, possibly a newer build.
/// Serialising with different settings than it is read with turns a delivery
/// failure into permanent data loss.
/// </para>
/// </remarks>
public static class AgentJson
{
    /// <summary>The shared wire convention: camelCase, named enums, nulls omitted.</summary>
    public static JsonSerializerOptions SerializerOptions => ContractJson.Default;
}
