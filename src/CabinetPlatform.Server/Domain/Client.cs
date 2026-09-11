namespace CabinetPlatform.Server.Domain;

/// <summary>
/// A client organisation. The top of the hierarchy: client, then site, then
/// cabinet.
/// </summary>
/// <remarks>
/// <para>
/// This exists as a row rather than as a string on every cabinet because it is
/// a security boundary, not a label. A cabinet-to-cabinet probe may never cross
/// it, and enforcing that against a denormalised name would mean comparing two
/// strings that a rename can quietly desynchronise.
/// </para>
/// <para>
/// Both extremes in the real fleet are ordinary: a client with one site and one
/// cabinet, and a client with many sites and many cabinets per site. Nothing
/// here assumes either.
/// </para>
/// </remarks>
public class Client
{
    /// <summary>Identifier of the client.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Client name, unique across the fleet.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Sites belonging to this client.</summary>
    public ICollection<Site> Sites { get; set; } = new List<Site>();
}

/// <summary>
/// One physical location of a client, and the cabinet that syncs it.
/// </summary>
/// <remarks>
/// <see cref="SyncCabinetId"/> is a single nullable column on purpose: it makes
/// "a site has at most one sync cabinet" a property of the schema rather than a
/// rule a service has to remember. A site with none is a standalone site, which
/// is supported and is not an error.
/// </remarks>
public class Site
{
    /// <summary>Identifier of the site.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Client this site belongs to.</summary>
    public Guid ClientId { get; set; }

    /// <summary>Navigation to that client.</summary>
    public Client? Client { get; set; }

    /// <summary>Site name, unique within its client.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// The one cabinet holding this site's data, or null for a standalone site.
    /// </summary>
    public Guid? SyncCabinetId { get; set; }

    /// <summary>Navigation to that cabinet.</summary>
    public Cabinet? SyncCabinet { get; set; }

    /// <summary>Cabinets at this site.</summary>
    public ICollection<Cabinet> Cabinets { get; set; } = new List<Cabinet>();
}

/// <summary>
/// One cabinet's most recent probe of another cabinet at the same site.
/// </summary>
/// <remarks>
/// Kept as its own row rather than derived from the last action result, because
/// the question the cabinet detail view asks — "can this satellite currently
/// reach its sync cabinet?" — has to be answerable without scanning an action
/// history, and because reachable-from-the-server is not the same fact.
/// </remarks>
public class CabinetLinkProbe
{
    /// <summary>Identifier of the probe record.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>The cabinet the probe ran from.</summary>
    public Guid SourceCabinetId { get; set; }

    /// <summary>The cabinet it probed.</summary>
    public Guid TargetCabinetId { get; set; }

    /// <summary>UTC instant the result was recorded.</summary>
    public DateTimeOffset ObservedUtc { get; set; }

    /// <summary>Whether the source reached the target.</summary>
    public bool Reachable { get; set; }

    /// <summary>Round-trip time, when the probe measured one.</summary>
    public double? LatencyMs { get; set; }
}
