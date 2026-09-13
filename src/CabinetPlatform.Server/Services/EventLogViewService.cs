using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Services;

/// <summary>
/// Reading, writing and expanding the shared event log views.
/// </summary>
/// <remarks>
/// Views are the answer to "support needs focused views per application rather
/// than one error firehose". A view is a set of named fields; the agent builds
/// its own query from them. Nothing here ever produces, stores or forwards an
/// XPath, and there is no method that takes one.
/// </remarks>
public interface IEventLogViewService
{
    /// <summary>Lists views.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the query.</param>
    Task<PagedResult<EventLogViewDto>> ListAsync(EventLogViewQuery query, CancellationToken ct);

    /// <summary>Reads one view.</summary>
    /// <param name="id">The view.</param>
    /// <param name="ct">Cancels the query.</param>
    Task<OperationResult<EventLogViewDto>> GetAsync(Guid id, CancellationToken ct);

    /// <summary>Defines a new view.</summary>
    /// <param name="actor">The Supervisor.</param>
    /// <param name="request">The definition.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<EventLogViewDto>> CreateAsync(
        CurrentUser actor, CreateEventLogViewRequest request, CancellationToken ct);

    /// <summary>Replaces an existing view's definition.</summary>
    /// <param name="actor">The Supervisor.</param>
    /// <param name="id">The view.</param>
    /// <param name="request">The new definition, in full.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<EventLogViewDto>> UpdateAsync(
        CurrentUser actor, Guid id, UpdateEventLogViewRequest request, CancellationToken ct);

    /// <summary>Retires a view so it stops being offered.</summary>
    /// <param name="actor">The Supervisor.</param>
    /// <param name="id">The view.</param>
    /// <param name="reason">Why. Audited.</param>
    /// <param name="ticketReference">Support ticket, if any.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<EventLogViewDto>> RetireAsync(
        CurrentUser actor, Guid id, string reason, string? ticketReference, CancellationToken ct);

    /// <summary>
    /// Expands a stored view into the definition an agent receives.
    /// </summary>
    /// <param name="id">The view.</param>
    /// <param name="windowHoursOverride">
    /// The window the rep asked for, or null to use the view's default.
    /// </param>
    /// <param name="ct">Cancels the query.</param>
    Task<OperationResult<EventLogViewDefinition>> ExpandAsync(
        Guid id, int? windowHoursOverride, CancellationToken ct);
}

/// <inheritdoc />
public sealed class EventLogViewService : IEventLogViewService
{
    /// <summary>Widest window a view may look back over, in hours.</summary>
    /// <remarks>
    /// A week. Beyond that the query stops being a diagnostic and becomes an
    /// export of the machine's whole log over a link shared with a clinic.
    /// </remarks>
    public const int MaximumWindowHours = 168;

    /// <summary>Most records one run of a view may return.</summary>
    public const int MaximumEntriesCeiling = 5000;

    private static readonly JsonSerializerOptions Json = ContractJson.CreateOptions();

    private readonly SupportDbContext _db;
    private readonly IAuditService _audit;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the service.</summary>
    /// <param name="db">The database.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="timeProvider">Clock.</param>
    public EventLogViewService(SupportDbContext db, IAuditService audit, TimeProvider timeProvider)
    {
        _db = db;
        _audit = audit;
        _timeProvider = timeProvider;
    }

    /// <inheritdoc />
    public async Task<PagedResult<EventLogViewDto>> ListAsync(
        EventLogViewQuery query, CancellationToken ct)
    {
        IQueryable<EventLogView> views = _db.EventLogViews.AsNoTracking();

        if (!query.IncludeRetired)
        {
            views = views.Where(v => !v.IsRetired);
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            string term = query.Search.Trim();
            views = views.Where(v => EF.Functions.Like(v.DisplayName, $"%{term}%"));
        }

        int total = await views.CountAsync(ct);

        List<EventLogView> page = await views
            .OrderBy(v => v.DisplayName)
            .Skip(query.Skip)
            .Take(query.PageSize)
            .ToListAsync(ct);

        return PagedResult<EventLogViewDto>.Create(
            page.Select(ToDto).ToList(), query.Page, query.PageSize, total);
    }

    /// <inheritdoc />
    public async Task<OperationResult<EventLogViewDto>> GetAsync(Guid id, CancellationToken ct)
    {
        EventLogView? view = await _db.EventLogViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == id, ct);

        return view is null
            ? OperationResult<EventLogViewDto>.NotFound("Event log view not found.")
            : OperationResult<EventLogViewDto>.Ok(ToDto(view));
    }

    /// <inheritdoc />
    public async Task<OperationResult<EventLogViewDto>> CreateAsync(
        CurrentUser actor, CreateEventLogViewRequest request, CancellationToken ct)
    {
        OperationResult validation = Validate(
            request.DisplayName,
            request.LogNames,
            request.ChannelNames,
            request.Sources,
            request.EventIds,
            request.MinimumLevel,
            request.DefaultWindowHours,
            request.MaximumEntries);

        if (!validation.Succeeded)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.CreateEventLogView, validation.Reason!, null,
                new { request.DisplayName }, null, ct);

            return OperationResult<EventLogViewDto>.Invalid(validation.Reason!);
        }

        string name = request.DisplayName.Trim();

        if (await _db.EventLogViews.AnyAsync(v => v.DisplayName == name, ct))
        {
            return OperationResult<EventLogViewDto>.Conflict(
                $"A view called '{name}' already exists. Views are shared across every rep, so two " +
                "with the same name would be indistinguishable in the picker.");
        }

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        var view = new EventLogView
        {
            DisplayName = name,
            Description = Clean(request.Description),
            LogNamesJson = SerialiseLogs(request.LogNames, request.ChannelNames),
            SourcesJson = JsonSerializer.Serialize(NormaliseSources(request.Sources), Json),
            EventIdsJson = JsonSerializer.Serialize(request.EventIds.Distinct().Order().ToArray(), Json),
            MinimumLevel = request.MinimumLevel,
            DefaultWindowHours = request.DefaultWindowHours,
            MaximumEntries = request.MaximumEntries,
            IsSeeded = false,
            CreatedUtc = nowUtc,
            CreatedByUserId = actor.UserId,
        };

        _db.EventLogViews.Add(view);

        // A view is shared by everyone, so writing one is a change to what every
        // rep sees. Caused, not Observed.
        _audit.Enqueue(Caused(AuditEvent.CreateEventLogView, actor, request.Reason, request.TicketReference, new
        {
            EventLogViewId = view.Id,
            view.DisplayName,
            LogNames = request.LogNames,
            ChannelNames = request.ChannelNames,
            Sources = request.Sources,
            EventIds = request.EventIds,
            MinimumLevel = request.MinimumLevel.ToString(),
            view.DefaultWindowHours,
            view.MaximumEntries,
        }));

        await _db.SaveChangesAsync(ct);

        return OperationResult<EventLogViewDto>.Ok(ToDto(view));
    }

    /// <inheritdoc />
    public async Task<OperationResult<EventLogViewDto>> UpdateAsync(
        CurrentUser actor, Guid id, UpdateEventLogViewRequest request, CancellationToken ct)
    {
        EventLogView? view = await _db.EventLogViews.FirstOrDefaultAsync(v => v.Id == id, ct);

        if (view is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.UpdateEventLogView, "Event log view not found.", null,
                new { EventLogViewId = id }, null, ct);

            return OperationResult<EventLogViewDto>.NotFound("Event log view not found.");
        }

        OperationResult validation = Validate(
            request.DisplayName,
            request.LogNames,
            request.ChannelNames,
            request.Sources,
            request.EventIds,
            request.MinimumLevel,
            request.DefaultWindowHours,
            request.MaximumEntries);

        if (!validation.Succeeded)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.UpdateEventLogView, validation.Reason!, null,
                new { EventLogViewId = id }, null, ct);

            return OperationResult<EventLogViewDto>.Invalid(validation.Reason!);
        }

        string name = request.DisplayName.Trim();

        if (await _db.EventLogViews.AnyAsync(v => v.Id != id && v.DisplayName == name, ct))
        {
            return OperationResult<EventLogViewDto>.Conflict($"A view called '{name}' already exists.");
        }

        // The whole definition is recorded before and after, because a narrowing
        // of a shared filter is exactly the change somebody will later need to
        // explain: a view that stopped showing the records everyone relied on
        // looks like a broken cabinet, not an edited filter.
        var before = new
        {
            view.DisplayName,
            LogNames = ReadLogs(view.LogNamesJson).LogNames,
            ChannelNames = ReadLogs(view.LogNamesJson).ChannelNames,
            Sources = Deserialise<string>(view.SourcesJson),
            EventIds = Deserialise<int>(view.EventIdsJson),
            MinimumLevel = view.MinimumLevel.ToString(),
            view.DefaultWindowHours,
            view.MaximumEntries,
        };

        view.DisplayName = name;
        view.Description = Clean(request.Description);
        view.LogNamesJson = SerialiseLogs(request.LogNames, request.ChannelNames);
        view.SourcesJson = JsonSerializer.Serialize(NormaliseSources(request.Sources), Json);
        view.EventIdsJson = JsonSerializer.Serialize(request.EventIds.Distinct().Order().ToArray(), Json);
        view.MinimumLevel = request.MinimumLevel;
        view.DefaultWindowHours = request.DefaultWindowHours;
        view.MaximumEntries = request.MaximumEntries;
        view.UpdatedUtc = _timeProvider.GetUtcNow();
        view.UpdatedByUserId = actor.UserId;

        _audit.Enqueue(Caused(AuditEvent.UpdateEventLogView, actor, request.Reason, request.TicketReference, new
        {
            EventLogViewId = view.Id,
            Before = before,
            After = new
            {
                view.DisplayName,
                LogNames = request.LogNames,
                ChannelNames = request.ChannelNames,
                Sources = request.Sources,
                EventIds = request.EventIds,
                MinimumLevel = request.MinimumLevel.ToString(),
                view.DefaultWindowHours,
                view.MaximumEntries,
            },
        }));

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();

            return OperationResult<EventLogViewDto>.Conflict(
                "This view was changed by another Supervisor while you were editing it. Reload and " +
                "try again.");
        }

        return OperationResult<EventLogViewDto>.Ok(ToDto(view));
    }

    /// <inheritdoc />
    public async Task<OperationResult<EventLogViewDto>> RetireAsync(
        CurrentUser actor, Guid id, string reason, string? ticketReference, CancellationToken ct)
    {
        EventLogView? view = await _db.EventLogViews.FirstOrDefaultAsync(v => v.Id == id, ct);

        if (view is null)
        {
            return OperationResult<EventLogViewDto>.NotFound("Event log view not found.");
        }

        if (string.IsNullOrWhiteSpace(reason))
        {
            return OperationResult<EventLogViewDto>.Invalid(
                "Retiring a view everyone uses needs a stated reason.");
        }

        if (view.IsRetired)
        {
            return OperationResult<EventLogViewDto>.Conflict("This view is already retired.");
        }

        // Retired, never deleted. An action request from two years ago names
        // this view by id, and a reviewer reading that request has to be able to
        // see what it actually ran.
        view.IsRetired = true;
        view.UpdatedUtc = _timeProvider.GetUtcNow();
        view.UpdatedByUserId = actor.UserId;

        _audit.Enqueue(Caused(AuditEvent.RetireEventLogView, actor, reason, ticketReference, new
        {
            EventLogViewId = view.Id,
            view.DisplayName,
        }));

        await _db.SaveChangesAsync(ct);

        return OperationResult<EventLogViewDto>.Ok(ToDto(view));
    }

    /// <inheritdoc />
    public async Task<OperationResult<EventLogViewDefinition>> ExpandAsync(
        Guid id, int? windowHoursOverride, CancellationToken ct)
    {
        EventLogView? view = await _db.EventLogViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == id, ct);

        if (view is null)
        {
            return OperationResult<EventLogViewDefinition>.NotFound("Event log view not found.");
        }

        if (view.IsRetired)
        {
            return OperationResult<EventLogViewDefinition>.Conflict(
                $"The view '{view.DisplayName}' has been retired and can no longer be run.");
        }

        int window = windowHoursOverride ?? view.DefaultWindowHours;

        if (window is < 1 || window > MaximumWindowHours)
        {
            return OperationResult<EventLogViewDefinition>.Invalid(
                $"A view may look back between 1 and {MaximumWindowHours} hours.");
        }

        var stored = ReadLogs(view.LogNamesJson);
        var validation = Validate(view.DisplayName, stored.LogNames, stored.ChannelNames,
            Deserialise<string>(view.SourcesJson), Deserialise<int>(view.EventIdsJson),
            view.MinimumLevel, window, view.MaximumEntries);
        if (!validation.Succeeded) return OperationResult<EventLogViewDefinition>.Invalid(validation.Reason!);

        return OperationResult<EventLogViewDefinition>.Ok(new EventLogViewDefinition
        {
            ViewId = view.Id,
            DisplayName = view.DisplayName,
            // A native view must fail closed on older agents, not run only its legacy subset.
            // Preserve the saved DTO, but carry the complete union in the new field on dispatch.
            LogNames = stored.ChannelNames.Count == 0 ? stored.LogNames : Array.Empty<EventLogName>(),
            ChannelNames = stored.ChannelNames.Count == 0 ? Array.Empty<string>()
                : stored.ChannelNames.Concat(stored.LogNames.Select(n => n.ToString()))
                    .Distinct(StringComparer.OrdinalIgnoreCase).ToArray(),
            Sources = Deserialise<string>(view.SourcesJson),
            EventIds = Deserialise<int>(view.EventIdsJson),
            MinimumLevel = view.MinimumLevel,
            WindowHours = window,
            MaximumEntries = view.MaximumEntries,
        });
    }

    /// <summary>Turns a stored row into its wire shape.</summary>
    /// <param name="view">The stored view.</param>
    public static EventLogViewDto ToDto(EventLogView view) => new()
    {
        Id = view.Id,
        DisplayName = view.DisplayName,
        Description = view.Description,
        LogNames = ReadLogs(view.LogNamesJson).LogNames,
        ChannelNames = ReadLogs(view.LogNamesJson).ChannelNames,
        Sources = Deserialise<string>(view.SourcesJson),
        EventIds = Deserialise<int>(view.EventIdsJson),
        MinimumLevel = view.MinimumLevel,
        DefaultWindowHours = view.DefaultWindowHours,
        MaximumEntries = view.MaximumEntries,
        IsSeeded = view.IsSeeded,
        CreatedUtc = view.CreatedUtc,
        UpdatedUtc = view.UpdatedUtc,
    };

    /// <summary>
    /// Checks a definition before it is stored.
    /// </summary>
    /// <remarks>
    /// A view with no logs matches nothing, and a rep running it sees an empty
    /// grid that looks exactly like a healthy cabinet. That is the single worst
    /// failure this screen can have, so it is refused at the point of writing
    /// rather than discovered on a call.
    /// </remarks>
    private static OperationResult Validate(
        string displayName,
        IReadOnlyList<EventLogName> logNames,
        IReadOnlyList<string> channelNames,
        IReadOnlyList<string> sources,
        IReadOnlyList<int> eventIds,
        EventLogLevel minimumLevel,
        int defaultWindowHours,
        int maximumEntries)
    {
        if (string.IsNullOrWhiteSpace(displayName) || displayName.Trim().Length > 128)
        {
            return OperationResult.Invalid("A view needs a name of up to 128 characters.");
        }

        if (logNames is null || channelNames is null || sources is null || eventIds is null)
            return OperationResult.Invalid("View collections cannot be null.");

        if (logNames.Count + channelNames.Count > 16 || channelNames.Any(n => !EventChannelName.IsValid(n)))
            return OperationResult.Invalid("A view may name at most 16 valid local Windows channels; paths and query expressions are not accepted.");

        if (logNames.Count + channelNames.Count == 0)
        {
            return OperationResult.Invalid(
                "A view must name at least one Windows log. A view with none matches nothing, and an " +
                "empty result looks exactly like a healthy cabinet.");
        }

        foreach (EventLogName log in logNames)
        {
            if (!Enum.IsDefined(log))
            {
                return OperationResult.Invalid($"'{log}' is not a Windows log this platform reads.");
            }
        }

        if (!Enum.IsDefined(minimumLevel) || minimumLevel == EventLogLevel.Unknown)
        {
            return OperationResult.Invalid(
                "A view's minimum level must be Verbose, Information, Warning, Error or Critical.");
        }

        if (sources.Count > 50)
        {
            return OperationResult.Invalid("A view may name at most 50 event sources.");
        }

        foreach (string source in sources)
        {
            if (string.IsNullOrWhiteSpace(source) || source.Trim().Length > 255)
            {
                return OperationResult.Invalid("An event source name must be between 1 and 255 characters.");
            }

            // The agent builds an XPath from these. It escapes them when it
            // does, and they are checked here as well, because a provider name
            // is a name and there is no reason for one to carry quotes,
            // brackets or control characters.
            if (source.Any(c => char.IsControl(c) || c is '\'' or '"' or '[' or ']' or '*'))
            {
                return OperationResult.Invalid(
                    $"'{source.Trim()}' is not a valid event source name.");
            }
        }

        if (eventIds.Count > 200)
        {
            return OperationResult.Invalid("A view may name at most 200 event ids.");
        }

        foreach (int eventId in eventIds)
        {
            if (eventId is < 0 or > 65535)
            {
                return OperationResult.Invalid($"{eventId} is not a Windows event id.");
            }
        }

        if (defaultWindowHours is < 1 || defaultWindowHours > MaximumWindowHours)
        {
            return OperationResult.Invalid(
                $"A view's default window must be between 1 and {MaximumWindowHours} hours.");
        }

        if (maximumEntries is < 1 || maximumEntries > MaximumEntriesCeiling)
        {
            return OperationResult.Invalid(
                $"A view may return between 1 and {MaximumEntriesCeiling} records.");
        }

        return OperationResult.Ok();
    }

    // Retain the existing text column and legacy array format. Native views use a
    // versioned object; old servers parse that as no logs and refuse execution.
    private sealed record StoredLogs(int Version, IReadOnlyList<EventLogName> LogNames, IReadOnlyList<string> ChannelNames);

    private static string SerialiseLogs(IReadOnlyList<EventLogName> logs, IReadOnlyList<string> channels)
        => channels.Count == 0
            ? JsonSerializer.Serialize(logs.Distinct().ToArray(), Json)
            : JsonSerializer.Serialize(new StoredLogs(1, logs.Distinct().ToArray(), channels.Distinct(StringComparer.OrdinalIgnoreCase).ToArray()), Json);

    private static StoredLogs ReadLogs(string json)
    {
        try
        {
            if (json.TrimStart().StartsWith("[", StringComparison.Ordinal))
                return new(1, Deserialise<EventLogName>(json), Array.Empty<string>());
            var stored = JsonSerializer.Deserialize<StoredLogs>(json, Json);
            if (stored is { Version: 1, LogNames: not null, ChannelNames: not null }) return stored;
        }
        catch (JsonException) { }
        return new(1, Array.Empty<EventLogName>(), Array.Empty<string>());
    }

    private static string[] NormaliseSources(IReadOnlyList<string> sources) => sources
        .Where(s => !string.IsNullOrWhiteSpace(s))
        .Select(s => s.Trim())
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    /// <summary>
    /// Reads one of the JSON columns, treating unreadable content as empty.
    /// </summary>
    /// <remarks>
    /// A column this build cannot parse yields an empty list rather than an
    /// exception, so one malformed row cannot take out the view picker for
    /// everybody. The view itself will then match nothing, which is visible and
    /// fixable, rather than failing the whole screen.
    /// </remarks>
    private static IReadOnlyList<T> Deserialise<T>(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<T[]>(json, Json) ?? Array.Empty<T>();
        }
        catch (JsonException)
        {
            return Array.Empty<T>();
        }
    }

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private AuditRecord Caused(
        AuditEvent auditEvent, CurrentUser actor, string reason, string? ticketReference, object details) =>
        new()
        {
            Event = auditEvent,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Reason = reason.Trim(),
            TicketReference = Clean(ticketReference),
            Details = details,
        };
}
