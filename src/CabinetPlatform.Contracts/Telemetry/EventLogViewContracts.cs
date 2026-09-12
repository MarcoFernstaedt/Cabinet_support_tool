using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// A named, saved filter over a cabinet's Windows event logs.
/// </summary>
/// <remarks>
/// <para>
/// Support does not want one error firehose. The question is nearly always
/// about a specific subsystem — the CUBEX application, Windows Update, the disk
/// stack, the service control manager — and the records that answer it are a
/// few dozen among tens of thousands. A view is that question, written down
/// once by somebody who knew the answer, and then shared with everyone.
/// </para>
/// <para>
/// A view is a set of named fields, never a query string. The agent receives
/// these fields and builds its own XPath from them; there is no path by which a
/// user-supplied expression reaches <c>EventLogQuery</c>. That is the same rule
/// as everywhere else in this product: a request names things, it does not
/// describe work.
/// </para>
/// <para>
/// Views are stored in the database and edited by Supervisors, which is one of
/// the few things Supervisors still do that other reps cannot. Everybody can
/// run one.
/// </para>
/// </remarks>
public sealed record EventLogViewDto
{
    /// <summary>Identifier of the view.</summary>
    public required Guid Id { get; init; }

    /// <summary>What a rep picks it by, for example "CUBEX application errors".</summary>
    public required string DisplayName { get; init; }

    /// <summary>One sentence saying what question this view answers.</summary>
    public string? Description { get; init; }

    /// <summary>Which Windows logs to read. At least one.</summary>
    public IReadOnlyList<EventLogName> LogNames { get; init; } = Array.Empty<EventLogName>();

    /// <summary>
    /// Provider names to restrict to, or empty for every provider in those
    /// logs.
    /// </summary>
    public IReadOnlyList<string> Sources { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Event ids to restrict to, or empty for every id.
    /// </summary>
    /// <remarks>
    /// The sharpest of the filters and the one that turns a view from "roughly
    /// the right area" into an answer: the four ids that mean a disk is
    /// retrying reads are worth more than every warning the disk stack emits.
    /// </remarks>
    public IReadOnlyList<int> EventIds { get; init; } = Array.Empty<int>();

    /// <summary>The least severe record worth returning.</summary>
    public required EventLogLevel MinimumLevel { get; init; }

    /// <summary>How far back the view looks by default, in hours.</summary>
    public required int DefaultWindowHours { get; init; }

    /// <summary>Largest number of records a run of this view returns.</summary>
    public required int MaximumEntries { get; init; }

    /// <summary>
    /// Whether this view was seeded by the platform. Seeded views can be edited
    /// like any other; the flag exists so a Supervisor can tell which ones they
    /// inherited.
    /// </summary>
    public required bool IsSeeded { get; init; }

    /// <summary>UTC instant the view was created.</summary>
    public required DateTimeOffset CreatedUtc { get; init; }

    /// <summary>UTC instant the view was last edited, when it has been.</summary>
    public DateTimeOffset? UpdatedUtc { get; init; }
}

/// <summary>A Supervisor defining a new event log view.</summary>
public sealed record CreateEventLogViewRequest
{
    /// <summary>What a rep will pick it by.</summary>
    public required string DisplayName { get; init; }

    /// <summary>One sentence saying what question it answers.</summary>
    public string? Description { get; init; }

    /// <summary>Which logs to read. At least one is required.</summary>
    public IReadOnlyList<EventLogName> LogNames { get; init; } = Array.Empty<EventLogName>();

    /// <summary>Provider names to restrict to, or empty for all.</summary>
    public IReadOnlyList<string> Sources { get; init; } = Array.Empty<string>();

    /// <summary>Event ids to restrict to, or empty for all.</summary>
    public IReadOnlyList<int> EventIds { get; init; } = Array.Empty<int>();

    /// <summary>The least severe record worth returning.</summary>
    public EventLogLevel MinimumLevel { get; init; } = EventLogLevel.Warning;

    /// <summary>How far back it looks by default, in hours.</summary>
    public int DefaultWindowHours { get; init; } = 24;

    /// <summary>Largest number of records a run returns.</summary>
    public int MaximumEntries { get; init; } = 500;

    /// <summary>Why the view is being created. Audited.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the change is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}

/// <summary>A Supervisor editing an existing view.</summary>
/// <remarks>
/// Every field is replaced, not merged. A partial update over a shared
/// definition is how one Supervisor silently undoes another's narrowing of a
/// filter, and a view nobody can reason about is a view nobody trusts.
/// </remarks>
public sealed record UpdateEventLogViewRequest
{
    /// <summary>What a rep picks it by.</summary>
    public required string DisplayName { get; init; }

    /// <summary>One sentence saying what question it answers.</summary>
    public string? Description { get; init; }

    /// <summary>Which logs to read.</summary>
    public IReadOnlyList<EventLogName> LogNames { get; init; } = Array.Empty<EventLogName>();

    /// <summary>Provider names to restrict to.</summary>
    public IReadOnlyList<string> Sources { get; init; } = Array.Empty<string>();

    /// <summary>Event ids to restrict to.</summary>
    public IReadOnlyList<int> EventIds { get; init; } = Array.Empty<int>();

    /// <summary>The least severe record worth returning.</summary>
    public required EventLogLevel MinimumLevel { get; init; }

    /// <summary>How far back it looks by default, in hours.</summary>
    public required int DefaultWindowHours { get; init; }

    /// <summary>Largest number of records a run returns.</summary>
    public required int MaximumEntries { get; init; }

    /// <summary>Why it is changing. Audited.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the change is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}

/// <summary>
/// A Supervisor retiring a view.
/// </summary>
/// <remarks>
/// Retired rather than deleted, because an action request from two years ago
/// names this view by id and a reviewer reading that request has to be able to
/// see what it actually ran.
/// </remarks>
public sealed record RetireEventLogViewRequest
{
    /// <summary>Why. Required, and audited.</summary>
    public required string Reason { get; init; }

    /// <summary>Support ticket the decision is associated with, if any.</summary>
    public string? TicketReference { get; init; }
}

/// <summary>Filter over the view list.</summary>
public sealed record EventLogViewQuery : PagedQuery
{
    /// <summary>Partial, case-insensitive match against the display name.</summary>
    public string? Search { get; init; }

    /// <summary>Include views a Supervisor has retired. Excluded by default.</summary>
    public bool IncludeRetired { get; init; }
}

/// <summary>
/// The definition as it is handed to an agent.
/// </summary>
/// <remarks>
/// Deliberately smaller than <see cref="EventLogViewDto"/>: it carries what the
/// agent needs to build a query and nothing about who wrote the view or when.
/// It travels as the value of a single validated parameter, serialised by the
/// server after the view has been read from the database — a caller cannot
/// supply one.
/// </remarks>
public sealed record EventLogViewDefinition
{
    /// <summary>Identifier of the view this came from, echoed back on the result.</summary>
    public required Guid ViewId { get; init; }

    /// <summary>The view's name, for the line the agent writes into its own log.</summary>
    public required string DisplayName { get; init; }

    /// <summary>Which logs to read.</summary>
    public IReadOnlyList<EventLogName> LogNames { get; init; } = Array.Empty<EventLogName>();

    /// <summary>Provider names to restrict to, or empty for all.</summary>
    public IReadOnlyList<string> Sources { get; init; } = Array.Empty<string>();

    /// <summary>Event ids to restrict to, or empty for all.</summary>
    public IReadOnlyList<int> EventIds { get; init; } = Array.Empty<int>();

    /// <summary>The least severe record worth returning.</summary>
    public required EventLogLevel MinimumLevel { get; init; }

    /// <summary>How far back to look, in hours, after the rep's own choice is applied.</summary>
    public required int WindowHours { get; init; }

    /// <summary>Largest number of records to return.</summary>
    public required int MaximumEntries { get; init; }
}

/// <summary>What running a view returned.</summary>
/// <remarks>
/// Event logs are never stored routinely. This is the result of one action, it
/// lives on that action's row, and it is shown to the operator who asked for
/// it. There is no background collection and no fleet-wide event log table.
/// </remarks>
public sealed record EventLogViewResultDto
{
    /// <summary>The view that was run.</summary>
    public required Guid ViewId { get; init; }

    /// <summary>Its name at the time it ran.</summary>
    public required string ViewDisplayName { get; init; }

    /// <summary>The window that was searched, in hours.</summary>
    public required int WindowHours { get; init; }

    /// <summary>The records that matched, newest first.</summary>
    public IReadOnlyList<EventLogEntry> Entries { get; init; } = Array.Empty<EventLogEntry>();

    /// <summary>
    /// Whether the record count hit the view's ceiling, so the operator knows
    /// they are looking at the newest <em>n</em> and not at everything.
    /// </summary>
    public required bool Truncated { get; init; }
}
