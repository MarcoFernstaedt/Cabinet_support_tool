using System.Text.Json;
using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Common;

/// <summary>
/// The wire convention shared by every component: camelCase properties, enums
/// as their names rather than their numbers, and nulls omitted on the wire.
/// </summary>
/// <remarks>
/// <para>
/// Names matter here beyond taste. A stored check-in payload and an audit
/// details blob are read years later, sometimes in a compliance review, and
/// "RebootMachine" survives a renumbering of the enum in a way that "9" does
/// not. Agent, server and console all serialise through this so none of them
/// can drift into a private dialect.
/// </para>
/// <para>
/// Every enum in this assembly also carries its own
/// <see cref="JsonStringEnumConverter"/> attribute, so name-based enum
/// encoding holds even for a caller that serialises with plain defaults. The
/// converter registered here is belt and braces, not the only guarantee.
/// </para>
/// <para>
/// <see cref="JsonIgnoreCondition.WhenWritingNull"/> shortens the wire without
/// changing meaning: an absent property deserialises to <see langword="null"/>,
/// which is exactly what a null section or an unread counter means.
/// </para>
/// </remarks>
public static class ContractJson
{
    /// <summary>Creates a fresh options instance callers may further configure.</summary>
    public static JsonSerializerOptions CreateOptions() => new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>A shared, immutable-by-convention instance for callers that just need one.</summary>
    public static JsonSerializerOptions Default { get; } = CreateOptions();
}
