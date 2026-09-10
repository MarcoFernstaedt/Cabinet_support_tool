using System.Text.Json;
using System.Text.Json.Serialization;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// The single serializer configuration the agent uses, for the wire and for the
/// offline spool alike.
/// </summary>
/// <remarks>
/// One shared instance matters here: a payload spooled during an outage is
/// deserialised by a later run of the agent, possibly a newer build. Serialising
/// with different settings than it is read back with turns a delivery failure
/// into permanent data loss.
/// </remarks>
public static class AgentJson
{
    public static JsonSerializerOptions SerializerOptions { get; } = new(JsonSerializerDefaults.Web)
    {
        // The contracts carry their own JsonStringEnumConverter attributes, so
        // enums travel as names; nothing here overrides that.
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
    };
}
