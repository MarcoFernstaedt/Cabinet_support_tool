using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>
/// A cabinet's part in its site's topology.
/// </summary>
/// <remarks>
/// <para>
/// Nearly every client site has one sync cabinet holding the data the other
/// cabinets at that site talk to. Diagnosing a site almost always means
/// reasoning about that relationship, so it is modelled rather than left for a
/// rep to infer from hostnames.
/// </para>
/// <para>
/// A site may hold at most one <see cref="Sync"/> cabinet, and may hold none:
/// standalone sites are real and are not an error state.
/// </para>
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CabinetRole
{
    /// <summary>The role has not been set. A cabinet is never approved in this state.</summary>
    Unknown = 0,

    /// <summary>Holds the site's data. The other cabinets at the site talk to it.</summary>
    Sync = 1,

    /// <summary>Talks to its site's sync cabinet.</summary>
    Satellite = 2,

    /// <summary>Operates alone. It neither holds site data nor talks to a sync cabinet.</summary>
    Standalone = 3,
}
