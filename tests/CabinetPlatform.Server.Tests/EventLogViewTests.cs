using System.Net;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The shared event log views: everybody runs them, Supervisors define them.
/// </summary>
/// <remarks>
/// The split is one of the few places role still decides anything. Running a
/// view reads one cabinet's logs and is ordinary support work. Editing one
/// changes what every rep sees on every cabinet, and a narrowed filter that
/// quietly stops showing the records people relied on looks exactly like a
/// healthy cabinet — which is the worst failure this screen can have.
/// </remarks>
public sealed class EventLogViewTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public EventLogViewTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public async Task The_platform_seeds_the_views_a_support_desk_needs_on_day_one()
    {
        // Support should not have to invent these before they can use the
        // screen. Each is a question that comes up on real calls.
        (HttpClient client, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("seeded"));

        PagedResult<EventLogViewDto>? views =
            await (await client.GetAsync("/api/event-log-views?pageSize=100"))
                .ReadAsync<PagedResult<EventLogViewDto>>();

        Assert.NotNull(views);

        string[] names = views!.Items.Select(v => v.DisplayName).ToArray();

        Assert.Contains("CUBEX application errors", names);
        Assert.Contains("Windows Update client", names);
        Assert.Contains("Disk and storage", names);
        Assert.Contains("Service control manager", names);
        Assert.Contains("Recent errors and warnings", names);

        // The general view has no source or id filter, so it returns results on
        // any Windows machine rather than only one running the cabinet stack.
        EventLogViewDto general = views.Items.Single(v => v.DisplayName == "Recent errors and warnings");
        Assert.Empty(general.Sources);
        Assert.Empty(general.EventIds);
        Assert.Equal(EventLogLevel.Warning, general.MinimumLevel);

        // The sharpest filter is the event id list: the ids that mean a disk is
        // retrying reads are worth more than every warning the disk stack emits.
        EventLogViewDto disks = views.Items.Single(v => v.DisplayName == "Disk and storage");
        Assert.NotEmpty(disks.EventIds);
        Assert.NotEmpty(disks.Sources);
        Assert.True(disks.IsSeeded);
    }

    [Fact]
    public async Task Any_rep_may_list_views_but_only_a_supervisor_may_define_one()
    {
        (HttpClient rep, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier2, Unique("viewrep"));

        Assert.Equal(HttpStatusCode.OK, (await rep.GetAsync("/api/event-log-views")).StatusCode);

        HttpResponseMessage refused = await rep.PostJsonAsync("/api/event-log-views", Definition("Rep view"));

        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
    }

    [Fact]
    public async Task A_supervisor_defining_a_view_states_a_reason_and_it_is_audited_as_caused()
    {
        // A view is shared by everyone, so writing one is a change to what
        // every rep sees. Caused, not Observed.
        (HttpClient supervisor, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("viewsuper"));

        string name = $"Bespoke view {Unique("v")}";

        HttpResponseMessage created = await supervisor.PostJsonAsync(
            "/api/event-log-views", Definition(name));

        Assert.Equal(HttpStatusCode.Created, created.StatusCode);

        Domain.AuditEntry entry = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.CreateEventLogView && a.ActorId == user.Id.ToString())
            .FirstAsync());

        Assert.Equal(AuditEventKind.Caused, entry.EventKind);
        Assert.Contains("CUBEX", entry.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_view_naming_no_logs_is_refused()
    {
        // A view with no logs matches nothing, and a rep running it sees an
        // empty grid that looks exactly like a healthy cabinet. That is the
        // single worst failure this screen can have.
        (HttpClient supervisor, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("nologs"));

        CreateEventLogViewRequest request = Definition($"Empty view {Unique("e")}") with
        {
            LogNames = Array.Empty<EventLogName>(),
        };

        HttpResponseMessage response = await supervisor.PostJsonAsync("/api/event-log-views", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("disk' or @Name='lsass")]
    [InlineData("disk]")]
    [InlineData("wild*card")]
    public async Task A_source_name_that_is_not_a_provider_name_is_refused(string source)
    {
        // A provider name has no business containing a quote or a bracket. The
        // agent escapes these too; refusing them here means a stored definition
        // never carries one in the first place.
        (HttpClient supervisor, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("badsrc"));

        CreateEventLogViewRequest request = Definition($"Bad source {Unique("b")}") with
        {
            Sources = new[] { source },
        };

        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await supervisor.PostJsonAsync("/api/event-log-views", request)).StatusCode);
    }

    [Fact]
    public async Task Running_a_view_attaches_the_stored_definition_the_agent_will_build_its_query_from()
    {
        // The caller names a view. The server reads it from the database and
        // attaches its fields, so what reaches the agent is a Supervisor's
        // definition rather than anything a caller composed.
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("runview"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: $"Run Client {Unique("c")}");

        Guid viewId = await _factory.WithDbAsync(db => db.EventLogViews
            .AsNoTracking()
            .Where(v => v.DisplayName == "Disk and storage")
            .Select(v => v.Id)
            .FirstAsync());

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.RunEventLogView,
            CabinetId = cabinet.Id,
            Parameters = new Dictionary<string, string>
            {
                [ActionParameterKeys.EventLogViewId] = viewId.ToString(),
                [ActionParameterKeys.HoursOfHistory] = "12",
            },
            Reason = "Checking whether this cabinet's disk is retrying reads.",
            TicketReference = "SUP-9001",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        ActionRequestView? view = await response.ReadAsync<ActionRequestView>();
        Assert.NotNull(view);

        string definitionJson = view!.Parameters[ActionParameterKeys.EventLogViewDefinition];

        EventLogViewDefinition? definition =
            JsonSerializer.Deserialize<EventLogViewDefinition>(definitionJson, TestClient.Json);

        Assert.NotNull(definition);
        Assert.Equal(viewId, definition!.ViewId);
        Assert.NotEmpty(definition.LogNames);
        Assert.NotEmpty(definition.EventIds);

        // The window the rep chose, echoed back, so the stored request says
        // what was run rather than what was asked for.
        Assert.Equal(12, definition.WindowHours);
        Assert.Equal("12", view.Parameters[ActionParameterKeys.HoursOfHistory]);
    }

    [Fact]
    public async Task A_request_carrying_its_own_view_definition_is_refused()
    {
        // The whole reason views are stored server-side is that nobody should
        // be able to hand an agent a filter of their own devising.
        (HttpClient client, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("ownview"));

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), user.Id, clientName: $"Own Client {Unique("c")}");

        Guid viewId = await _factory.WithDbAsync(db => db.EventLogViews
            .AsNoTracking()
            .Select(v => v.Id)
            .FirstAsync());

        HttpResponseMessage response = await client.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.RunEventLogView,
            CabinetId = cabinet.Id,
            Parameters = new Dictionary<string, string>
            {
                [ActionParameterKeys.EventLogViewId] = viewId.ToString(),
                [ActionParameterKeys.EventLogViewDefinition] = "{\"LogNames\":[\"Security\"]}",
            },
            Reason = "Trying to supply my own filter.",
            TicketReference = "SUP-9002",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task A_retired_view_can_no_longer_be_run_but_is_still_readable()
    {
        // Retired, never deleted: an action request from two years ago names
        // this view by id, and a reviewer reading that request has to be able
        // to see what it actually ran.
        (HttpClient supervisor, _) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("retire"));

        (HttpClient rep, User repUser) = await TestClient.CreateUserClientAsync(
            _factory, Role.Tier1, Unique("retirerep"));

        string name = $"Retired view {Unique("r")}";

        EventLogViewDto? created =
            await (await supervisor.PostJsonAsync("/api/event-log-views", Definition(name)))
                .ReadAsync<EventLogViewDto>();

        Assert.NotNull(created);

        Assert.Equal(
            HttpStatusCode.OK,
            (await supervisor.PostJsonAsync(
                $"/api/event-log-views/{created!.Id}/retire",
                new RetireEventLogViewRequest { Reason = "Superseded by the seeded CUBEX view." }))
            .StatusCode);

        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(
            _factory, Unique("m"), repUser.Id, clientName: $"Retired Client {Unique("c")}");

        HttpResponseMessage run = await rep.PostJsonAsync("/api/actions", new CreateActionRequest
        {
            Action = ActionName.RunEventLogView,
            CabinetId = cabinet.Id,
            Parameters = new Dictionary<string, string>
            {
                [ActionParameterKeys.EventLogViewId] = created.Id.ToString(),
            },
            Reason = "Running a view that has been retired.",
            TicketReference = "SUP-9003",
        });

        Assert.Equal(HttpStatusCode.Conflict, run.StatusCode);

        // Still readable, so the old request can still be explained.
        Assert.Equal(
            HttpStatusCode.OK,
            (await rep.GetAsync($"/api/event-log-views/{created.Id}")).StatusCode);
    }

    [Fact]
    public async Task Editing_a_view_records_what_it_looked_like_before_and_after()
    {
        // A narrowed shared filter is exactly the change somebody will later
        // need to explain: a view that stopped showing the records everyone
        // relied on looks like a broken cabinet, not an edited filter.
        (HttpClient supervisor, User user) = await TestClient.CreateUserClientAsync(
            _factory, Role.Supervisor, Unique("edit"));

        string name = $"Edited view {Unique("e")}";

        EventLogViewDto? created =
            await (await supervisor.PostJsonAsync("/api/event-log-views", Definition(name)))
                .ReadAsync<EventLogViewDto>();

        Assert.NotNull(created);

        HttpResponseMessage updated = await supervisor.PutJsonAsync(
            $"/api/event-log-views/{created!.Id}",
            new UpdateEventLogViewRequest
            {
                DisplayName = name,
                LogNames = new[] { EventLogName.System },
                Sources = new[] { "disk" },
                EventIds = new[] { 7 },
                MinimumLevel = EventLogLevel.Error,
                DefaultWindowHours = 48,
                MaximumEntries = 200,
                Reason = "Narrowed to the four ids that actually precede a failing drive.",
            });

        Assert.Equal(HttpStatusCode.OK, updated.StatusCode);

        Domain.AuditEntry entry = await _factory.WithDbAsync(db => db.AuditEntries
            .AsNoTracking()
            .Where(a => a.Event == AuditEvent.UpdateEventLogView && a.ActorId == user.Id.ToString())
            .FirstAsync());

        Assert.Equal(AuditEventKind.Caused, entry.EventKind);
        // Both halves, so the change is reconstructable rather than merely
        // dated. The details are serialised in the wire convention, so the
        // comparison ignores case rather than pinning it.
        Assert.Contains("before", entry.Details!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("after", entry.Details!, StringComparison.OrdinalIgnoreCase);

        // And the narrowing itself is visible: the level went from Warning to
        // Error, which is the kind of edit that makes records stop appearing.
        Assert.Contains("Warning", entry.Details!, StringComparison.Ordinal);
        Assert.Contains("Error", entry.Details!, StringComparison.Ordinal);
    }

    private static CreateEventLogViewRequest Definition(string name) => new()
    {
        DisplayName = name,
        Description = "Errors from the CUBEX application stack.",
        LogNames = new[] { EventLogName.Application },
        Sources = new[] { "MashuraCabinetService" },
        EventIds = new[] { 1000, 1026 },
        MinimumLevel = EventLogLevel.Warning,
        DefaultWindowHours = 24,
        MaximumEntries = 500,
        Reason = "The CUBEX stack needs its own view rather than the whole Application log.",
        TicketReference = "SUP-8000",
    };

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..20];
}
