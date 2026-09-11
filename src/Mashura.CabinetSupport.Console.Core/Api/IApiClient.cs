using Mashura.CabinetSupport.Contracts.Actions;
using Mashura.CabinetSupport.Contracts.Audit;
using Mashura.CabinetSupport.Contracts.Cabinets;
using Mashura.CabinetSupport.Contracts.Common;
using Mashura.CabinetSupport.Contracts.Users;

namespace Mashura.CabinetSupport.Console.Core.Api;

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

    // --- Cabinets --------------------------------------------------------

    Task<PagedResult<CabinetSummary>> GetCabinetsAsync(CabinetQuery query, CancellationToken ct);

    Task<CabinetLatestDto> GetCabinetLatestAsync(Guid cabinetId, CancellationToken ct);

    Task<PagedResult<CheckInSummaryDto>> GetCheckInHistoryAsync(
        Guid cabinetId, HistoryQuery query, CancellationToken ct);

    Task<PagedResult<SmartReadingDto>> GetSmartHistoryAsync(
        Guid cabinetId, SmartHistoryQuery query, CancellationToken ct);

    // --- Actions ---------------------------------------------------------

    /// <summary>
    /// The catalogue, as the server describes it. The console uses it to label
    /// and disable buttons; the server enforces every rule in it regardless.
    /// </summary>
    Task<IReadOnlyList<ActionCatalogEntryDto>> GetActionCatalogAsync(CancellationToken ct);

    Task<ActionRequestDto> CreateActionAsync(CreateActionRequest request, CancellationToken ct);

    Task<ActionRequestDto> GetActionAsync(Guid actionId, CancellationToken ct);

    Task<PagedResult<ActionRequestDto>> GetActionsAsync(ActionQuery query, CancellationToken ct);

    /// <summary>
    /// Actions this caller is eligible to approve. The server already excludes
    /// the caller's own requests from this list; the Approvals view fetches
    /// those separately so it can show them dimmed with the reason rather than
    /// leaving a gap the user cannot explain.
    /// </summary>
    Task<PagedResult<ActionRequestDto>> GetPendingApprovalsAsync(PagedQuery query, CancellationToken ct);

    Task<ActionRequestDto> ApproveActionAsync(
        Guid actionId, ApproveActionRequest request, CancellationToken ct);

    Task<ActionRequestDto> DenyActionAsync(Guid actionId, DenyActionRequest request, CancellationToken ct);

    // --- Audit and fleet -------------------------------------------------

    Task<PagedResult<AuditEntryDto>> GetAuditAsync(AuditQuery query, CancellationToken ct);

    Task<FleetHealthSummary> GetFleetHealthAsync(FleetHealthQuery query, CancellationToken ct);
}
