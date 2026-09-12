using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>
/// One search result, pre-formatted for display and for reading aloud.
/// </summary>
/// <remarks>
/// Every string this row exposes names the cabinet in full. There is no
/// hostname-only property here and there should not be one: the grid this binds
/// to is where a rep decides which of seven thousand cabinets they are about to
/// work on.
/// </remarks>
public sealed class CabinetSearchRow
{
    /// <summary>Creates the row.</summary>
    /// <param name="hit">The server's result.</param>
    /// <param name="nowUtc">The current instant, for the check-in age.</param>
    public CabinetSearchRow(CabinetSearchHit hit, DateTimeOffset nowUtc)
    {
        Hit = hit;
        Health = StatusPresentation.ForCabinet(hit.Cabinet.Health);
        LastCheckInAge = Format.Age(hit.Cabinet.LastCheckInUtc, nowUtc);
    }

    /// <summary>The server's result.</summary>
    public CabinetSearchHit Hit { get; }

    /// <summary>The cabinet's full identifying path.</summary>
    public CabinetPath Path => Hit.Path;

    /// <summary>Identifier of the cabinet.</summary>
    public Guid Id => Hit.Cabinet.Id;

    /// <summary>The one-line identification.</summary>
    public string Display => Hit.Path.Display;

    /// <summary>The client this cabinet belongs to.</summary>
    public string ClientName => Hit.Path.ClientName;

    /// <summary>The site within that client.</summary>
    public string SiteName => Hit.Path.SiteName;

    /// <summary>The department, or a dash when the client does not use them.</summary>
    public string Department => Format.Text(Hit.Path.DepartmentName);

    /// <summary>The cabinet's own name.</summary>
    public string CabinetName => Hit.Path.CabinetName;

    /// <summary>Its part in its site's topology, as a person reads it.</summary>
    public string RoleLabel => CabinetIdentity.RoleLabel(Hit.Path.Role);

    /// <summary>Its serial number, or a dash when it has not reported one.</summary>
    public string SerialNumber => Format.Text(Hit.Path.SerialNumber);

    /// <summary>Rolled-up health.</summary>
    public StatusPresentation Health { get; }

    /// <summary>How long ago the cabinet last checked in.</summary>
    public string LastCheckInAge { get; }

    /// <summary>Whether another cabinet in this result set carries the same name.</summary>
    public bool HasDuplicateName => Hit.Path.HostnameIsAmbiguous;

    /// <summary>
    /// The duplicate-name marker, or empty when the name is unique in this set.
    /// </summary>
    /// <remarks>
    /// Text rather than only a colour or an icon. Two identically-named rows
    /// distinguished by something the eye skips is precisely how the wrong
    /// cabinet gets picked, and a colour is invisible to a screen reader.
    /// </remarks>
    public string DuplicateNameMarker => HasDuplicateName ? CabinetIdentity.AmbiguityMarker : string.Empty;

    /// <summary>
    /// Which field the term matched, so a rep can see why a row is here.
    /// </summary>
    /// <remarks>
    /// A serial-number match on a row whose name looks unrelated is otherwise
    /// baffling, and a baffled rep is one who tries a different search rather
    /// than trusting the right answer they were already given.
    /// </remarks>
    public string MatchedOn => Hit.MatchedOn switch
    {
        CabinetSearchMatch.ClientName => "client name",
        CabinetSearchMatch.SiteName => "site name",
        CabinetSearchMatch.Department => "department",
        CabinetSearchMatch.Hostname => "cabinet name",
        CabinetSearchMatch.SerialNumber => "serial number",
        CabinetSearchMatch.CabinetId => "cabinet id",
        _ => string.Empty,
    };

    /// <summary>The whole row as one sentence, for a screen reader.</summary>
    public string AccessibleSummary =>
        $"{Hit.Path.Spoken} Health {Health.Label}. Last check-in {LastCheckInAge}." +
        (MatchedOn.Length > 0 ? $" Matched on {MatchedOn}." : string.Empty);
}

/// <summary>One recently opened cabinet, pre-formatted for display.</summary>
public sealed class RecentCabinetRow
{
    /// <summary>Creates the row.</summary>
    /// <param name="recent">The server's record.</param>
    /// <param name="nowUtc">The current instant, for the age.</param>
    public RecentCabinetRow(RecentCabinetDto recent, DateTimeOffset nowUtc)
    {
        Recent = recent;
        Health = StatusPresentation.ForCabinet(recent.Health);
        ViewedAge = Format.Age(recent.LastViewedUtc, nowUtc);
    }

    /// <summary>The server's record.</summary>
    public RecentCabinetDto Recent { get; }

    /// <summary>The cabinet's full identifying path.</summary>
    public CabinetPath Path => Recent.Path;

    /// <summary>Identifier of the cabinet.</summary>
    public Guid Id => Recent.Path.CabinetId;

    /// <summary>The one-line identification.</summary>
    public string Display => Recent.Path.Display;

    /// <summary>Rolled-up health when the list was built.</summary>
    public StatusPresentation Health { get; }

    /// <summary>How long ago this rep last opened it.</summary>
    public string ViewedAge { get; }

    /// <summary>The whole row as one sentence, for a screen reader.</summary>
    public string AccessibleSummary =>
        $"{Recent.Path.Spoken} Health {Health.Label}. Opened {ViewedAge}.";
}
