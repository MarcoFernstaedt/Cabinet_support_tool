using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Domain;

/// <summary>
/// A named, saved filter over a cabinet's Windows event logs, shared across
/// every support user.
/// </summary>
/// <remarks>
/// <para>
/// Stored in the database rather than in code, because the useful filters are
/// discovered in the field: the four event ids that mean a CUBEX dispense
/// timed out are learned on a call, not designed in advance. Supervisors write
/// them down once and everybody gets them.
/// </para>
/// <para>
/// Note what is not stored here: an XPath, a query string, or any other
/// expression. The columns are named fields, and the agent builds its own query
/// from them. A stored query string would be a command travelling from the
/// database to a cabinet, and this product does not have one of those anywhere.
/// </para>
/// </remarks>
public class EventLogView
{
    /// <summary>Identifier of the view.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>What a rep picks it by. Unique, so two views cannot be confused.</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>One sentence saying what question this view answers.</summary>
    public string? Description { get; set; }

    /// <summary>
    /// Which Windows logs to read, as a JSON array of
    /// <see cref="EventLogName"/> names.
    /// </summary>
    /// <remarks>
    /// Held as JSON rather than as a child table because it is read whole,
    /// written whole, and never queried across: no endpoint asks "which views
    /// mention the System log". A join table would buy nothing and cost a
    /// migration every time the shape moved.
    /// </remarks>
    public string LogNamesJson { get; set; } = "[]";

    /// <summary>Provider names to restrict to, as a JSON array. Empty means all.</summary>
    public string SourcesJson { get; set; } = "[]";

    /// <summary>Event ids to restrict to, as a JSON array. Empty means all.</summary>
    public string EventIdsJson { get; set; } = "[]";

    /// <summary>The least severe record worth returning.</summary>
    public EventLogLevel MinimumLevel { get; set; } = EventLogLevel.Warning;

    /// <summary>How far back the view looks by default, in hours.</summary>
    public int DefaultWindowHours { get; set; } = 24;

    /// <summary>Largest number of records one run returns.</summary>
    public int MaximumEntries { get; set; } = 500;

    /// <summary>
    /// Whether the platform seeded this view. Seeded views are editable like
    /// any other; the flag only says where it came from.
    /// </summary>
    public bool IsSeeded { get; set; }

    /// <summary>
    /// Retired views are kept rather than deleted, so an action request that
    /// ran one years ago still resolves to the definition it ran.
    /// </summary>
    public bool IsRetired { get; set; }

    /// <summary>UTC instant the view was created.</summary>
    public DateTimeOffset CreatedUtc { get; set; }

    /// <summary>Which Supervisor created it, or null for a seeded view.</summary>
    public Guid? CreatedByUserId { get; set; }

    /// <summary>UTC instant it was last edited.</summary>
    public DateTimeOffset? UpdatedUtc { get; set; }

    /// <summary>Which Supervisor last edited it.</summary>
    public Guid? UpdatedByUserId { get; set; }

    /// <summary>
    /// Optimistic concurrency token. Two Supervisors narrowing the same shared
    /// filter at once must not have one silently discard the other.
    /// </summary>
    public byte[]? RowVersion { get; set; }
}

/// <summary>
/// One cabinet a support user has opened, and when they last did.
/// </summary>
/// <remarks>
/// <para>
/// Held per user on the server rather than in a console's local settings, so
/// that it follows a rep between machines and survives a client restart in the
/// middle of a call. With seven thousand cabinets, "the one I was just looking
/// at" is a query a rep runs dozens of times a day.
/// </para>
/// <para>
/// One row per user and cabinet, updated in place. A history of every view
/// would be a second audit trail with none of the guarantees of the real one,
/// and the real one already records every read.
/// </para>
/// </remarks>
public class RecentCabinetView
{
    /// <summary>Identifier of the row.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>The support user.</summary>
    public Guid UserId { get; set; }

    /// <summary>The cabinet they opened.</summary>
    public Guid CabinetId { get; set; }

    /// <summary>Navigation to that cabinet.</summary>
    public Cabinet? Cabinet { get; set; }

    /// <summary>UTC instant they last opened it.</summary>
    public DateTimeOffset LastViewedUtc { get; set; }
}
