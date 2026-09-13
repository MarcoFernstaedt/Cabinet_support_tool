using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// The console's entire view of the server: one typed method per endpoint,
/// returning Contracts types.
/// </summary>
/// <remarks>
/// <para>
/// No ViewModel builds a URL, sets a header, or reads a status code. That is
/// not style — it is the only way the client's behaviour on the unhappy paths
/// (401, 403, 429, unreachable) can be written once and relied on everywhere,
/// instead of being reinvented per screen with slightly different bugs.
/// </para>
/// <para>
/// Note what is not here: no method takes a command, a script, a query or any
/// other free text the server would execute. The surface is exactly the
/// server's surface, and the server has no such endpoint at any role.
/// </para>
/// </remarks>
public interface IApiClient
{
    // --- Authentication --------------------------------------------------

    /// <summary>
    /// Signs in and populates the session, including the user id from
    /// <c>/api/auth/me</c> where the token permits that call.
    /// </summary>
    Task<LoginResponse> LoginAsync(LoginRequest request, CancellationToken ct);

    /// <summary>
    /// Changes the signed-in user's own password. Reachable while the session
    /// is flagged must-change, because it is one of the two things such a
    /// session is allowed to do.
    /// </summary>
    Task ChangePasswordAsync(ChangePasswordRequest request, CancellationToken ct);

    /// <summary>The caller's identity, as the server resolves it.</summary>
    Task<UserDto> GetCurrentUserAsync(CancellationToken ct);

    // --- Enrollment ------------------------------------------------------

    Task<PagedResult<CabinetPlatform.Contracts.Registrations.PendingRegistrationDto>> GetRegistrationsAsync(
        CabinetPlatform.Contracts.Registrations.RegistrationQuery query, CancellationToken ct);
    Task<CabinetPlatform.Contracts.Registrations.PendingRegistrationDto> ApproveRegistrationAsync(
        Guid id, CabinetPlatform.Contracts.Registrations.ApproveRegistrationRequest request, CancellationToken ct);
    Task RejectRegistrationAsync(
        Guid id, CabinetPlatform.Contracts.Registrations.RejectRegistrationRequest request, CancellationToken ct);

    // --- Cabinets --------------------------------------------------------

    Task<PagedResult<CabinetSummary>> GetCabinetsAsync(CabinetQuery query, CancellationToken ct);

    Task<CabinetDetailDto> GetCabinetLatestAsync(Guid cabinetId, CancellationToken ct);

    Task<PagedResult<HeartbeatDto>> GetCheckInHistoryAsync(
        Guid cabinetId, HistoryQuery query, CancellationToken ct);

    Task<PagedResult<SmartReadingDto>> GetSmartHistoryAsync(
        Guid cabinetId, SmartHistoryQuery query, CancellationToken ct);

    // --- Finding a cabinet -----------------------------------------------

    /// <summary>
    /// Searches across client name, site name, department, hostname, serial
    /// number and cabinet id at once.
    /// </summary>
    /// <remarks>
    /// One term, every identifying column, because a rep does not know in
    /// advance which kind of thing they are holding. Every hit carries the
    /// cabinet's full path, and hits whose names collide within the page are
    /// flagged by the server.
    /// </remarks>
    /// <param name="query">What to look for, and which page.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<PagedResult<CabinetSearchHit>> SearchCabinetsAsync(
        CabinetSearchQuery query, CancellationToken ct);

    /// <summary>The client list, for the top level of the hierarchy browser.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<PagedResult<ClientSummary>> GetClientsAsync(ClientQuery query, CancellationToken ct);

    /// <summary>One client's sites, each with its cabinets, sync cabinet first.</summary>
    /// <param name="clientId">The client.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<ClientHierarchyDto> GetClientHierarchyAsync(Guid clientId, CancellationToken ct);

    /// <summary>
    /// The cabinets this rep has opened most recently.
    /// </summary>
    /// <remarks>
    /// Scoped to the caller by their token. There is no parameter for whose
    /// list to fetch, and no endpoint that would serve somebody else's.
    /// </remarks>
    /// <param name="limit">How many to return.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<IReadOnlyList<RecentCabinetDto>> GetRecentCabinetsAsync(int limit, CancellationToken ct);

    // --- Event log views -------------------------------------------------

    /// <summary>The saved event log views a rep may run.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<PagedResult<EventLogViewDto>> GetEventLogViewsAsync(
        EventLogViewQuery query, CancellationToken ct);

    /// <summary>Creates an audited shared view. The server requires a Supervisor.</summary>
    Task<EventLogViewDto> CreateEventLogViewAsync(CreateEventLogViewRequest request, CancellationToken ct)
        => throw new NotSupportedException("This client cannot create event views.");

    // --- Actions ---------------------------------------------------------

    /// <summary>
    /// The catalogue, as the server describes it. The console uses it to label
    /// and disable buttons; the server enforces every rule in it regardless.
    /// </summary>
    Task<IReadOnlyList<ActionCatalogEntryDto>> GetActionCatalogAsync(CancellationToken ct);

    Task<ActionRequestView> CreateActionAsync(CreateActionRequest request, CancellationToken ct);

    Task<ActionRequestView> GetActionAsync(Guid actionId, CancellationToken ct);

    Task<PagedResult<ActionRequestView>> GetActionsAsync(ActionQuery query, CancellationToken ct);

    /// <summary>
    /// Actions this caller is eligible to approve. The server already excludes
    /// the caller's own requests from this list; the Approvals view fetches
    /// those separately so it can show them dimmed with the reason rather than
    /// leaving a gap the user cannot explain.
    /// </summary>
    Task<PagedResult<ActionRequestView>> GetPendingApprovalsAsync(PagedQuery query, CancellationToken ct);

    Task<ActionRequestView> ApproveActionAsync(
        Guid actionId, ApproveActionRequest request, CancellationToken ct);

    Task<ActionRequestView> DenyActionAsync(Guid actionId, DenyActionRequest request, CancellationToken ct);

    // --- Audit and fleet -------------------------------------------------

    Task<PagedResult<AuditEntryDto>> GetAuditAsync(AuditQuery query, CancellationToken ct);

    Task<FleetHealthSummary> GetFleetHealthAsync(FleetHealthQuery query, CancellationToken ct);

    // --- Topology --------------------------------------------------------

    /// <summary>
    /// The site list, worst first, with each site's sync cabinet on the row.
    /// </summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<PagedResult<SiteSummary>> GetSitesAsync(SiteQuery query, CancellationToken ct);

    /// <summary>One site and its cabinets, the sync cabinet first.</summary>
    /// <param name="siteId">The site.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<SiteDetailDto> GetSiteAsync(Guid siteId, CancellationToken ct);

    /// <summary>Changes a cabinet's part in its site's topology.</summary>
    /// <param name="cabinetId">The cabinet.</param>
    /// <param name="request">The new role and why.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<CabinetSummary> SetCabinetRoleAsync(
        Guid cabinetId, SetCabinetRoleRequest request, CancellationToken ct);

    /// <summary>
    /// Tests a cabinet's link to its site's sync cabinet, in one call.
    /// </summary>
    /// <remarks>
    /// The common case by a wide margin. The server resolves the target and its
    /// address; the rep picks nothing and types nothing.
    /// </remarks>
    /// <param name="cabinetId">The cabinet to test from.</param>
    /// <param name="request">Why, and against which ticket.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<ActionRequestView> TestSyncLinkAsync(
        Guid cabinetId, TestSyncLinkRequest request, CancellationToken ct);

    // --- Batches ---------------------------------------------------------

    /// <summary>
    /// Requests one action across an explicit list of cabinets.
    /// </summary>
    /// <remarks>
    /// The console never loops over the single-action endpoint to do this. A
    /// Supervisor asked to approve fifty separate one-cabinet requests is being
    /// shown the same information arranged so nobody can weigh it.
    /// </remarks>
    /// <param name="request">The action, its parameters and its frozen targets.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<BatchActionView> CreateBatchAsync(CreateBatchActionRequest request, CancellationToken ct);

    /// <summary>One batch, with every cabinet's own state.</summary>
    /// <param name="batchId">The batch.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<BatchActionView> GetBatchAsync(Guid batchId, CancellationToken ct);

    /// <summary>The batch list.</summary>
    /// <param name="query">Filter and page.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<PagedResult<BatchActionView>> GetBatchesAsync(BatchActionQuery query, CancellationToken ct);

    /// <summary>Approves a batch, expanding it into one request per cabinet.</summary>
    /// <param name="batchId">The batch.</param>
    /// <param name="request">The approver's note.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<BatchActionView> ApproveBatchAsync(
        Guid batchId, ApproveActionRequest request, CancellationToken ct);

    /// <summary>Refuses a batch. Nothing is expanded and nothing is dispatched.</summary>
    /// <param name="batchId">The batch.</param>
    /// <param name="request">Why.</param>
    /// <param name="ct">Cancels the call.</param>
    Task<BatchActionView> DenyBatchAsync(Guid batchId, DenyActionRequest request, CancellationToken ct);
}
