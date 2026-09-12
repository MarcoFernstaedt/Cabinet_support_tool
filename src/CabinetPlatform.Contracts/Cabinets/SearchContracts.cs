using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>
/// The full identifying path of one cabinet: client, site, department, cabinet
/// name and the part it plays at its site.
/// </summary>
/// <remarks>
/// <para>
/// This type exists because picking the wrong cabinet is the most likely
/// serious operator error in this product. Three and a half thousand
/// organisations run seven thousand cabinets, and hostnames repeat freely
/// across them — <c>CUBEX01</c> is a name hundreds of clients have chosen
/// independently. A bare hostname is therefore never an identification, and
/// nothing in this API returns one on its own.
/// </para>
/// <para>
/// The path travels as structured fields rather than as a pre-joined string so
/// that a console can render the client name larger than the rest, or read the
/// parts out in a different order for a screen reader, without parsing.
/// <see cref="Display"/> is offered for the cases where one line is what is
/// wanted, and is computed identically everywhere because it is computed here.
/// </para>
/// </remarks>
public sealed record CabinetPath
{
    /// <summary>Identifier of the cabinet.</summary>
    public required Guid CabinetId { get; init; }

    /// <summary>Client organisation the cabinet belongs to.</summary>
    public required string ClientName { get; init; }

    /// <summary>Site within that client.</summary>
    public required string SiteName { get; init; }

    /// <summary>Identifier of that site, so a console can group without matching names.</summary>
    public required Guid SiteId { get; init; }

    /// <summary>Department within the site, when the client uses them.</summary>
    public string? DepartmentName { get; init; }

    /// <summary>The cabinet's own name, which is its current hostname.</summary>
    public required string CabinetName { get; init; }

    /// <summary>The cabinet's part in its site's topology.</summary>
    public required CabinetRole Role { get; init; }

    /// <summary>Serial number, when the cabinet has reported one.</summary>
    public string? SerialNumber { get; init; }

    /// <summary>
    /// Whether another cabinet in the same result set carries this hostname.
    /// </summary>
    /// <remarks>
    /// Set by the server across the page it is returning, because that is the
    /// only place the whole set is visible at once. A console showing a result
    /// set where this is true must distinguish the rows both visually and in
    /// their text — two identically-named rows that differ only in a column the
    /// eye skips is exactly how the wrong cabinet gets picked.
    /// </remarks>
    public bool HostnameIsAmbiguous { get; init; }

    /// <summary>
    /// The path on one line: client, site, department where there is one, then
    /// the cabinet name and its role.
    /// </summary>
    /// <remarks>
    /// Computed rather than stored, and computed here rather than in each
    /// console, so that every list, dialog and confirmation spells a cabinet
    /// the same way. A rep who has read one of these has read all of them.
    /// </remarks>
    public string Display =>
        string.IsNullOrWhiteSpace(DepartmentName)
            ? $"{ClientName} › {SiteName} › {CabinetName} ({Role})"
            : $"{ClientName} › {SiteName} › {DepartmentName} › {CabinetName} ({Role})";

    /// <summary>
    /// The path as a sentence, for a screen reader and for a confirmation a
    /// person has to read rather than glance at.
    /// </summary>
    public string Spoken
    {
        get
        {
            string department = string.IsNullOrWhiteSpace(DepartmentName)
                ? string.Empty
                : $"department {DepartmentName}, ";

            string serial = string.IsNullOrWhiteSpace(SerialNumber)
                ? string.Empty
                : $" Serial {SerialNumber}.";

            string ambiguity = HostnameIsAmbiguous
                ? " Warning: another cabinet in these results has the same name."
                : string.Empty;

            return $"Client {ClientName}, site {SiteName}, {department}cabinet {CabinetName}, " +
                   $"{Role} role.{serial}{ambiguity}";
        }
    }

    /// <summary>Builds a path from a cabinet summary.</summary>
    /// <param name="summary">The cabinet.</param>
    /// <param name="hostnameIsAmbiguous">
    /// Whether another cabinet in the same result set shares its hostname.
    /// </param>
    public static CabinetPath From(CabinetSummary summary, bool hostnameIsAmbiguous = false) => new()
    {
        CabinetId = summary.Id,
        ClientName = summary.ClientName,
        SiteName = summary.SiteName,
        SiteId = summary.SiteId,
        DepartmentName = summary.DepartmentName,
        CabinetName = summary.Hostname,
        Role = summary.Role,
        SerialNumber = summary.SerialNumber,
        HostnameIsAmbiguous = hostnameIsAmbiguous,
    };

    /// <summary>
    /// Marks every path whose cabinet name is shared by another path in the
    /// same set.
    /// </summary>
    /// <remarks>
    /// Applied over the page being returned rather than over the whole fleet.
    /// Telling a rep that a hostname is duplicated somewhere among seven
    /// thousand cabinets is noise; telling them that two rows in front of them
    /// carry the same name is the warning that prevents the mistake.
    /// </remarks>
    /// <param name="paths">The result set.</param>
    public static IReadOnlyList<CabinetPath> MarkAmbiguity(IReadOnlyList<CabinetPath> paths)
    {
        HashSet<string> duplicated = paths
            .GroupBy(p => p.CabinetName, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (duplicated.Count == 0)
        {
            return paths;
        }

        return paths
            .Select(p => p with { HostnameIsAmbiguous = duplicated.Contains(p.CabinetName) })
            .ToList();
    }
}

/// <summary>
/// What a rep types into the search box, and how much of the answer they want.
/// </summary>
/// <remarks>
/// One field, matched across everything a rep might have to hand: the client
/// who rang, the site they named, the department, the hostname on the sticker,
/// the serial number, or a cabinet id pasted from a ticket. Reps do not know in
/// advance which kind of thing they are holding, so making them choose a field
/// first would be asking them a question they cannot answer.
/// </remarks>
public sealed record CabinetSearchQuery : PagedQuery
{
    /// <summary>
    /// What to look for. Matched case-insensitively and as a partial match
    /// against every identifying column.
    /// </summary>
    public string? Term { get; init; }

    /// <summary>Restrict to in-service or withdrawn cabinets. Both by default.</summary>
    public bool? IsActive { get; init; }
}

/// <summary>One cabinet as a search result.</summary>
/// <remarks>
/// Carries the summary and the path together. The summary is what a grid
/// column binds to; the path is what identifies the row to a person, and is
/// never omitted in favour of the hostname alone.
/// </remarks>
public sealed record CabinetSearchHit
{
    /// <summary>The cabinet's list-view facts.</summary>
    public required CabinetSummary Cabinet { get; init; }

    /// <summary>Its full identifying path.</summary>
    public required CabinetPath Path { get; init; }

    /// <summary>
    /// Which field the term matched, so a rep can see why a row is in the
    /// result — a serial-number match on a row whose name looks unrelated is
    /// otherwise baffling.
    /// </summary>
    public required CabinetSearchMatch MatchedOn { get; init; }
}

/// <summary>Which identifying field a search term matched.</summary>
[System.Text.Json.Serialization.JsonConverter(typeof(System.Text.Json.Serialization.JsonStringEnumConverter))]
public enum CabinetSearchMatch
{
    /// <summary>Nothing was searched for; the row is here because the list was unfiltered.</summary>
    None = 0,

    /// <summary>The client's name matched.</summary>
    ClientName = 1,

    /// <summary>The site's name matched.</summary>
    SiteName = 2,

    /// <summary>The department matched.</summary>
    Department = 3,

    /// <summary>The cabinet's hostname matched.</summary>
    Hostname = 4,

    /// <summary>The serial number matched.</summary>
    SerialNumber = 5,

    /// <summary>The cabinet id matched.</summary>
    CabinetId = 6,
}

/// <summary>A client organisation, for the hierarchy browser's top level.</summary>
public sealed record ClientSummary
{
    /// <summary>Identifier of the client.</summary>
    public required Guid Id { get; init; }

    /// <summary>Client name.</summary>
    public required string Name { get; init; }

    /// <summary>How many sites the client has.</summary>
    public required int SiteCount { get; init; }

    /// <summary>How many cabinets across those sites.</summary>
    public required int CabinetCount { get; init; }

    /// <summary>Worst rolled-up health across those cabinets.</summary>
    public required CabinetHealthStatus WorstHealth { get; init; }
}

/// <summary>Filter over the client list.</summary>
public sealed record ClientQuery : PagedQuery
{
    /// <summary>Partial, case-insensitive match against the client name.</summary>
    public string? Search { get; init; }
}

/// <summary>
/// One client with its sites, and each site with its cabinets.
/// </summary>
/// <remarks>
/// The other half of finding a cabinet. Search answers "I have a name"; this
/// answers "the client rang and I do not know which of their sites it is", and
/// a rep who has worked a client before navigates it faster than they can spell
/// a hostname.
/// </remarks>
public sealed record ClientHierarchyDto
{
    /// <summary>The client.</summary>
    public required ClientSummary Client { get; init; }

    /// <summary>Its sites, worst health first, each with its cabinets.</summary>
    public IReadOnlyList<SiteWithCabinetsDto> Sites { get; init; } = Array.Empty<SiteWithCabinetsDto>();
}

/// <summary>One site and the cabinets at it, the sync cabinet first.</summary>
public sealed record SiteWithCabinetsDto
{
    /// <summary>The site.</summary>
    public required SiteSummary Site { get; init; }

    /// <summary>
    /// Its cabinets, the sync cabinet first and the rest by name.
    /// </summary>
    /// <remarks>
    /// The sync cabinet leads because when a whole site misbehaves it is
    /// usually the cause, and a rep should not have to find it among twenty
    /// rows.
    /// </remarks>
    public IReadOnlyList<CabinetPath> Cabinets { get; init; } = Array.Empty<CabinetPath>();
}

/// <summary>
/// A cabinet this rep has looked at recently.
/// </summary>
/// <remarks>
/// Per rep and held by the server rather than by one console installation, so
/// that it follows a rep between machines and so that "what was I just looking
/// at" survives a client restart mid-call.
/// </remarks>
public sealed record RecentCabinetDto
{
    /// <summary>The cabinet's full identifying path.</summary>
    public required CabinetPath Path { get; init; }

    /// <summary>UTC instant this rep last opened it.</summary>
    public required DateTimeOffset LastViewedUtc { get; init; }

    /// <summary>Its rolled-up health when the list was built.</summary>
    public required CabinetHealthStatus Health { get; init; }
}
