using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mashura.CabinetSupport.Contracts.Common;

/// <summary>
/// The wire convention shared by every component: camelCase properties and
/// enums as their names rather than their numbers.
///
/// Names matter here beyond taste. A stored check-in payload and an audit
/// details blob are read years later, sometimes in a compliance review, and
/// "RebootMachine" survives a renumbering of the enum in a way that "9" does
/// not. Agent, server and console all serialise through this so none of them
/// can drift into a private dialect.
/// </summary>
public static class ContractJson
{
    public static JsonSerializerOptions CreateOptions() => new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>A shared, immutable-by-convention instance for callers that just need one.</summary>
    public static JsonSerializerOptions Default { get; } = CreateOptions();
}
