using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Registrations;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// The only place in the console that speaks HTTP.
/// </summary>
public sealed class ApiClient : IApiClient, IDisposable
{
    private readonly CancellationTokenSource _lifetime = new();
    private readonly CancellationToken _lifetimeToken;
    private bool _disposed;
    private static readonly JsonSerializerOptions Json = ContractJson.CreateOptions();

    private readonly HttpClient _http;
    private readonly ISessionStore _session;
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<ISessionStore, SemaphoreSlim> RefreshGates = new();

    public ApiClient(HttpClient http, ISessionStore session)
    {
        _lifetimeToken = _lifetime.Token;
        _http = http;
        _session = session;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _lifetime.Cancel();
        _session.SignOut();
        _http.Dispose();
        _lifetime.Dispose();
    }

    // --- Authentication --------------------------------------------------

    public async Task<LoginResponse> LoginAsync(LoginRequest request, CancellationToken ct)
    {
        LoginResponse response = await PostAsync<LoginRequest, LoginResponse>(
            "api/auth/login", request, isLogin: true, ct);

        _session.SignIn(
            response.AccessToken,
            response.ExpiresAtUtc,
            response.RefreshToken,
            response.DisplayName,
            response.Role,
            response.MustChangePassword);

        // The user id lives only on /api/auth/me, and the Approvals view needs
        // it to tell the user's own requests apart from everyone else's. A
        // must-change-password session is allowed to make this call, so there
        // is no case where a signed-in console lacks an identity.
        try
        {
            UserDto me = await GetCurrentUserAsync(ct);
            _session.AttachIdentity(me.Id, me.Username, me.Role, me.MustChangePassword);
        }
        catch (ApiException)
        {
            // Sign-in itself succeeded. Losing the follow-up call costs the
            // Approvals view its "this one is yours" marking and nothing else,
            // so it must not look like a failed login. The four-eyes rule is
            // enforced by the server either way.
        }

        return response;
    }

    public Task ChangePasswordAsync(ChangePasswordRequest request, CancellationToken ct) =>
        PostAsync("api/auth/change-password", request, ct);

    public Task<UserDto> GetCurrentUserAsync(CancellationToken ct) =>
        GetAsync<UserDto>("api/auth/me", ct);

    // --- Enrollment ------------------------------------------------------
    public Task<PagedResult<ConnectivityAlertDto>> GetConnectivityAlertsAsync(ConnectivityAlertQuery query, CancellationToken ct) =>
        GetAsync<PagedResult<ConnectivityAlertDto>>("api/connectivity-alerts" + new QueryString()
            .Add("sourceCabinetId", query.SourceCabinetId).Add("siteId", query.SiteId)
            .Add("includeResolved", query.IncludeResolved)
            .Add("page", query.Page).Add("pageSize", query.PageSize), ct);
    public Task<ConnectivitySiteWorkloadDto> GetConnectivitySiteWorkloadAsync(Guid siteId, CancellationToken ct) =>
        GetAsync<ConnectivitySiteWorkloadDto>($"api/connectivity-alerts/site/{siteId:D}/summary", ct);
    public Task AcknowledgeConnectivityAlertAsync(Guid id, AnnotateConnectivityAlertRequest request, CancellationToken ct) =>
        PostAsync($"api/connectivity-alerts/{id:D}/acknowledge", request, ct);
    public Task ResolveConnectivityAlertAsync(Guid id, AnnotateConnectivityAlertRequest request, CancellationToken ct) =>
        PostAsync($"api/connectivity-alerts/{id:D}/resolve", request, ct);
    public Task<PagedResult<UserDto>> GetUsersAsync(PagedQuery query, CancellationToken ct) =>
        GetAsync<PagedResult<UserDto>>("api/users" + new QueryString().Add("page", query.Page).Add("pageSize", query.PageSize), ct);
    public Task<UserDto> CreateUserAsync(CreateUserRequest request, CancellationToken ct) =>
        PostAsync<CreateUserRequest, UserDto>("api/users", request, isLogin: false, ct);
    public Task<UserDto> UpdateUserAsync(Guid id, UpdateUserRequest request, CancellationToken ct) =>
        PatchAsync<UpdateUserRequest, UserDto>($"api/users/{id:D}", request, ct);

    public Task<PagedResult<PendingRegistrationDto>> GetRegistrationsAsync(RegistrationQuery query, CancellationToken ct) =>
        GetAsync<PagedResult<PendingRegistrationDto>>("api/registrations/pending" + new QueryString()
            .Add("status", query.Status).Add("page", query.Page).Add("pageSize", query.PageSize), ct);

    public Task<PendingRegistrationDto> ApproveRegistrationAsync(Guid id, ApproveRegistrationRequest request, CancellationToken ct) =>
        PostAsync<ApproveRegistrationRequest, PendingRegistrationDto>($"api/registrations/{id:D}/approve", request, isLogin: false, ct);

    public Task RejectRegistrationAsync(Guid id, RejectRegistrationRequest request, CancellationToken ct) =>
        PostAsync($"api/registrations/{id:D}/reject", request, ct);

    public Task<ConnectivityStatusDto> GetConnectivityAsync(Guid cabinetId, CancellationToken ct) =>
        GetAsync<ConnectivityStatusDto>($"api/connectivity/cabinets/{cabinetId:D}", ct);

    // --- Cabinets --------------------------------------------------------

    public Task<PagedResult<CabinetSummary>> GetCabinetsAsync(CabinetQuery query, CancellationToken ct)
    {
        string url = "api/cabinets" + new QueryString()
            .Add("clientName", query.ClientName)
            .Add("siteName", query.SiteName)
            .Add("siteId", query.SiteId)
            .Add("search", query.Search)
            .Add("isActive", query.IsActive)
            .Add("health", query.Health)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<CabinetSummary>>(url, ct);
    }

    public Task<CabinetDetailDto> GetCabinetLatestAsync(Guid cabinetId, CancellationToken ct) =>
        GetAsync<CabinetDetailDto>($"api/cabinets/{cabinetId:D}", ct);

    public Task<PagedResult<HeartbeatDto>> GetCheckInHistoryAsync(
        Guid cabinetId, HistoryQuery query, CancellationToken ct)
    {
        string url = $"api/cabinets/{cabinetId:D}/heartbeats" + new QueryString()
            .Add("fromUtc", query.FromUtc)
            .Add("toUtc", query.ToUtc)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<HeartbeatDto>>(url, ct);
    }

    public Task<PagedResult<SmartReadingDto>> GetSmartHistoryAsync(
        Guid cabinetId, SmartHistoryQuery query, CancellationToken ct)
    {
        string url = $"api/cabinets/{cabinetId:D}/smart" + new QueryString()
            .Add("driveSerial", query.DriveSerial)
            .Add("fromUtc", query.FromUtc)
            .Add("toUtc", query.ToUtc)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<SmartReadingDto>>(url, ct);
    }

    // --- Actions ---------------------------------------------------------

    public async Task<IReadOnlyList<ActionCatalogEntryDto>> GetActionCatalogAsync(CancellationToken ct) =>
        await GetAsync<List<ActionCatalogEntryDto>>("api/actions/catalog", ct);

    public Task<ActionRequestView> CreateActionAsync(CreateActionRequest request, CancellationToken ct) =>
        PostAsync<CreateActionRequest, ActionRequestView>("api/actions", request, isLogin: false, ct);

    public Task<ActionRequestView> GetActionAsync(Guid actionId, CancellationToken ct) =>
        GetAsync<ActionRequestView>($"api/actions/{actionId:D}", ct);

    public Task<PagedResult<ActionRequestView>> GetActionsAsync(ActionQuery query, CancellationToken ct)
    {
        string url = "api/actions" + new QueryString()
            .Add("cabinetId", query.CabinetId)
            .Add("status", query.Status)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<ActionRequestView>>(url, ct);
    }

    public Task<PagedResult<ActionRequestView>> GetPendingApprovalsAsync(PagedQuery query, CancellationToken ct)
    {
        string url = "api/actions/pending-approval" + new QueryString()
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<ActionRequestView>>(url, ct);
    }

    public Task<ActionRequestView> ApproveActionAsync(
        Guid actionId, ApproveActionRequest request, CancellationToken ct) =>
        PostAsync<ApproveActionRequest, ActionRequestView>(
            $"api/actions/{actionId:D}/approve", request, isLogin: false, ct);

    public Task<ActionRequestView> DenyActionAsync(
        Guid actionId, DenyActionRequest request, CancellationToken ct) =>
        PostAsync<DenyActionRequest, ActionRequestView>(
            $"api/actions/{actionId:D}/deny", request, isLogin: false, ct);

    // --- Audit and fleet -------------------------------------------------

    public Task<PagedResult<AuditEntryDto>> GetAuditAsync(AuditQuery query, CancellationToken ct)
    {
        string url = "api/audit" + new QueryString()
            .Add("cabinetId", query.CabinetId)
            .Add("actorId", query.ActorId)
            .Add("eventKind", query.EventKind)
            .Add("result", query.Result)
            .Add("action", query.Action)
            .Add("fromUtc", query.FromUtc)
            .Add("toUtc", query.ToUtc)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<AuditEntryDto>>(url, ct);
    }

    public Task<FleetHealthSummary> GetFleetHealthAsync(FleetHealthQuery query, CancellationToken ct)
    {
        string url = "api/fleet/health" + new QueryString()
            .Add("clientName", query.ClientName)
            .Add("siteName", query.SiteName);

        return GetAsync<FleetHealthSummary>(url, ct);
    }

    // --- Topology --------------------------------------------------------

    /// <inheritdoc />
    public Task<PagedResult<CabinetSearchHit>> SearchCabinetsAsync(
        CabinetSearchQuery query, CancellationToken ct)
    {
        string url = "api/search/cabinets" + new QueryString()
            .Add("term", query.Term)
            .Add("isActive", query.IsActive)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<CabinetSearchHit>>(url, ct);
    }

    /// <inheritdoc />
    public Task<PagedResult<ClientSummary>> GetClientsAsync(ClientQuery query, CancellationToken ct)
    {
        string url = "api/search/clients" + new QueryString()
            .Add("search", query.Search)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<ClientSummary>>(url, ct);
    }

    /// <inheritdoc />
    public Task<ClientHierarchyDto> GetClientHierarchyAsync(Guid clientId, CancellationToken ct) =>
        GetAsync<ClientHierarchyDto>($"api/search/clients/{clientId}", ct);

    /// <inheritdoc />
    public Task<IReadOnlyList<RecentCabinetDto>> GetRecentCabinetsAsync(int limit, CancellationToken ct) =>
        GetAsync<IReadOnlyList<RecentCabinetDto>>(
            "api/search/recent" + new QueryString().Add("limit", limit), ct);

    /// <inheritdoc />
    public Task<EventLogViewDto> CreateEventLogViewAsync(CreateEventLogViewRequest request, CancellationToken ct) =>
        PostAsync<CreateEventLogViewRequest, EventLogViewDto>("api/event-log-views", request, isLogin: false, ct);

    /// <inheritdoc />
    public Task<PagedResult<EventLogViewDto>> GetEventLogViewsAsync(
        EventLogViewQuery query, CancellationToken ct)
    {
        string url = "api/event-log-views" + new QueryString()
            .Add("search", query.Search)
            .Add("includeRetired", query.IncludeRetired)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<EventLogViewDto>>(url, ct);
    }

    /// <inheritdoc />
    public Task<PagedResult<SiteSummary>> GetSitesAsync(SiteQuery query, CancellationToken ct)
    {
        string url = "api/fleet/sites" + new QueryString()
            .Add("clientName", query.ClientName)
            .Add("search", query.Search)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<SiteSummary>>(url, ct);
    }

    /// <inheritdoc />
    public Task<SiteDetailDto> GetSiteAsync(Guid siteId, CancellationToken ct) =>
        GetAsync<SiteDetailDto>($"api/fleet/sites/{siteId:D}", ct);

    /// <inheritdoc />
    public Task<CabinetSummary> SetCabinetRoleAsync(
        Guid cabinetId, SetCabinetRoleRequest request, CancellationToken ct) =>
        PutAsync<SetCabinetRoleRequest, CabinetSummary>(
            $"api/cabinets/{cabinetId:D}/role", request, ct);

    /// <inheritdoc />
    public Task<ActionRequestView> TestSyncLinkAsync(
        Guid cabinetId, TestSyncLinkRequest request, CancellationToken ct) =>
        PostAsync<TestSyncLinkRequest, ActionRequestView>(
            $"api/actions/cabinets/{cabinetId:D}/test-sync-link", request, isLogin: false, ct);

    // --- Batches ---------------------------------------------------------

    /// <inheritdoc />
    public Task<BatchActionView> CreateBatchAsync(CreateBatchActionRequest request, CancellationToken ct) =>
        PostAsync<CreateBatchActionRequest, BatchActionView>("api/batches", request, isLogin: false, ct);

    /// <inheritdoc />
    public Task<BatchActionView> GetBatchAsync(Guid batchId, CancellationToken ct) =>
        GetAsync<BatchActionView>($"api/batches/{batchId:D}", ct);

    /// <inheritdoc />
    public Task<PagedResult<BatchActionView>> GetBatchesAsync(
        BatchActionQuery query, CancellationToken ct)
    {
        string url = "api/batches" + new QueryString()
            .Add("status", query.Status)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<BatchActionView>>(url, ct);
    }

    /// <inheritdoc />
    public Task<BatchActionView> ApproveBatchAsync(
        Guid batchId, ApproveActionRequest request, CancellationToken ct) =>
        PostAsync<ApproveActionRequest, BatchActionView>(
            $"api/batches/{batchId:D}/approve", request, isLogin: false, ct);

    /// <inheritdoc />
    public Task<BatchActionView> DenyBatchAsync(
        Guid batchId, DenyActionRequest request, CancellationToken ct) =>
        PostAsync<DenyActionRequest, BatchActionView>(
            $"api/batches/{batchId:D}/deny", request, isLogin: false, ct);

    // --- Transport -------------------------------------------------------

    public Task<CabinetSummary> RenameCabinetAsync(Guid cabinetId, RenameCabinetRequest request, CancellationToken ct) =>
        PatchAsync<RenameCabinetRequest, CabinetSummary>($"api/cabinets/{cabinetId:D}/name", request, ct);

    private async Task<TResponse> PatchAsync<TRequest, TResponse>(string url, TRequest body, CancellationToken ct)
    {
        using var response = await SendWithRefreshAsync(() => new HttpRequestMessage(HttpMethod.Patch, url)
        { Content = JsonContent.Create(body, options: Json) }, ct);
        return await ReadAsync<TResponse>(response, isLogin: false, ct);
    }

    private async Task<TResponse> PutAsync<TRequest, TResponse>(
        string url, TRequest body, CancellationToken ct)
    {
        using HttpResponseMessage response = await SendWithRefreshAsync(
            () => new HttpRequestMessage(HttpMethod.Put, url)
            {
                Content = JsonContent.Create(body, options: Json),
            },
            ct);

        return await ReadAsync<TResponse>(response, isLogin: false, ct);
    }

    private async Task<T> GetAsync<T>(string url, CancellationToken ct)
    {
        using HttpResponseMessage response = await SendWithRefreshAsync(
            () => new HttpRequestMessage(HttpMethod.Get, url), ct);

        return await ReadAsync<T>(response, isLogin: false, ct);
    }

    /// <summary>
    /// Sends a request and, on a 401, exchanges the refresh token once and
    /// sends it again.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Access tokens last fifteen minutes, so a rep working through a shift
    /// crosses that boundary many times. Making them sign in again each time
    /// would teach them to keep the console closed, which is the opposite of
    /// what a support tool wants.
    /// </para>
    /// <para>
    /// Exactly one retry. A second 401 after a fresh token means the session is
    /// genuinely over — the account was disabled, the role was withdrawn, a
    /// Supervisor revoked the chain — and looping would turn that into a hang
    /// instead of a sign-in prompt.
    /// </para>
    /// </remarks>
    private async Task<HttpResponseMessage> SendWithRefreshAsync(
        Func<HttpRequestMessage> requestFactory, CancellationToken ct)
    {
        long generation = _session.Generation;
        string? access = _session.AccessToken;
        HttpResponseMessage response = await SendAsync(requestFactory, ct);
        if (response.StatusCode != HttpStatusCode.Unauthorized) return response;

        var gate = RefreshGates.GetValue(_session, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            if (generation != _session.Generation) return response;
            if (access == _session.AccessToken)
            {
                if (_session.RefreshToken is not { } refresh ||
                    !await TryRefreshAsync(generation, refresh, ct)) return response;
            }
            if (generation != _session.Generation) return response;
            response.Dispose();
            return await SendAsync(requestFactory, ct);
        }
        finally { gate.Release(); }
    }

    private async Task<bool> TryRefreshAsync(long generation, string refreshToken, CancellationToken ct)
    {
        using HttpResponseMessage response = await SendAsync(
            () => new HttpRequestMessage(HttpMethod.Post, "api/auth/refresh")
            {
                Content = JsonContent.Create(new RefreshRequest { RefreshToken = refreshToken }, options: Json),
            },
            ct);

        if (!response.IsSuccessStatusCode)
        {
            return false;
        }

        RefreshResponse? refreshed = await ReadResponseBodyAsync(
            token => response.Content.ReadFromJsonAsync<RefreshResponse>(Json, token), ct);

        if (refreshed is null)
        {
            return false;
        }

        return _session.TryRefreshed(generation, refreshToken, refreshed);
    }

    private async Task<TResponse> PostAsync<TRequest, TResponse>(
        string url, TRequest body, bool isLogin, CancellationToken ct)
    {
        // Sign-in cannot be retried through a refresh: it is the call that
        // produces one.
        using HttpResponseMessage response = isLogin
            ? await SendAsync(Factory(), ct)
            : await SendWithRefreshAsync(Factory(), ct);

        return await ReadAsync<TResponse>(response, isLogin, ct);

        Func<HttpRequestMessage> Factory() => () => new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(body, options: Json),
        };
    }

    private async Task PostAsync<TRequest>(string url, TRequest body, CancellationToken ct)
    {
        using HttpResponseMessage response = await SendWithRefreshAsync(
            () => new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = JsonContent.Create(body, options: Json)
            },
            ct);

        if (!response.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(response, isLogin: false, ct);
        }
    }

    /// <summary>
    /// Sends the request and turns transport-level faults into
    /// <see cref="ApiFailure.Unreachable"/>.
    /// </summary>
    /// <remarks>
    /// Cancellation is re-thrown rather than reported. A user who clicked away
    /// from a cabinet has not encountered an error, and telling them the server
    /// is unreachable because they navigated would teach them to distrust the
    /// message when the server really is down. The token check distinguishes
    /// the two: a timeout also surfaces as cancellation, and only an
    /// uncancelled token means the deadline, not the user, ended the call.
    /// </remarks>
    private async Task<HttpResponseMessage> SendAsync(
        Func<HttpRequestMessage> requestFactory, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _lifetimeToken);
        linked.Token.ThrowIfCancellationRequested();
        using HttpRequestMessage request = requestFactory();

        try
        {
            HttpResponseMessage response = await _http.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, linked.Token);

            // A cancelled call does not get to produce an error message. Whether
            // the cancellation raced the response or the server noticed the
            // disconnect and answered 499, the user navigated away — and telling
            // them the request was refused would be false.
            if (linked.IsCancellationRequested)
            {
                response.Dispose();
                linked.Token.ThrowIfCancellationRequested();
            }

            return response;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw new OperationCanceledException(ct);
        }
        catch (OperationCanceledException) when (_lifetimeToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(_lifetimeToken);
        }
        catch (OperationCanceledException ex)
        {
            throw new ApiException(
                ApiFailure.Unreachable,
                "The server did not respond in time. Check the network connection and try again.",
                inner: ex);
        }
        catch (HttpRequestException ex)
        {
            throw new ApiException(
                ApiFailure.Unreachable,
                $"The support server could not be reached at {_http.BaseAddress}. {ex.Message}",
                inner: ex);
        }
    }

    private async Task<T> ReadAsync<T>(HttpResponseMessage response, bool isLogin, CancellationToken ct)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(response, isLogin, ct);
        }

        try
        {
            T? value = await ReadResponseBodyAsync(
                token => response.Content.ReadFromJsonAsync<T>(Json, token), ct);

            if (value is null)
            {
                throw new ApiException(
                    ApiFailure.ServerError,
                    "The server returned an empty response where data was expected.",
                    (int)response.StatusCode);
            }

            return value;
        }
        catch (JsonException ex)
        {
            throw new ApiException(
                ApiFailure.ServerError,
                "The server's response could not be read. It may be a different version than this console.",
                (int)response.StatusCode,
                ex);
        }
    }

    // ResponseHeadersRead completes SendAsync before any body is consumed.
    // Normalize faults at this separate boundary without retrying a possible write.
    private async Task<T> ReadResponseBodyAsync<T>(Func<CancellationToken, Task<T>> read, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _lifetimeToken);
        try
        {
            linked.Token.ThrowIfCancellationRequested();
            T value = await read(linked.Token);
            linked.Token.ThrowIfCancellationRequested();
            return value;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw new OperationCanceledException(ct);
        }
        catch (OperationCanceledException) when (_lifetimeToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(_lifetimeToken);
        }
        catch (OperationCanceledException ex)
        {
            throw new ApiException(ApiFailure.Unreachable,
                "The server response did not arrive in time. The operation may already have completed.", inner: ex);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            ct.ThrowIfCancellationRequested();
            _lifetimeToken.ThrowIfCancellationRequested();
            throw new ApiException(ApiFailure.Unreachable,
                "The connection was lost while reading the server response. The operation may already have completed.",
                inner: ex);
        }
    }

    /// <summary>
    /// Maps a failure response to an <see cref="ApiException"/>, preferring the
    /// server's own <c>ProblemDetails.detail</c> as the message.
    /// </summary>
    private async Task<ApiException> ToExceptionAsync(
        HttpResponseMessage response, bool isLogin, CancellationToken ct)
    {
        int status = (int)response.StatusCode;
        string? detail = await ReadResponseBodyAsync(token => TryReadProblemDetailAsync(response, token), ct);

        ApiFailure failure = status switch
        {
            // 499 is what a reverse proxy — and ASP.NET Core's own pipeline —
            // reports when the client went away. Reaching here means our own
            // token was not cancelled, so the disconnect happened in between:
            // a transport problem, not a refusal.
            499 => ApiFailure.Unreachable,
            _ => response.StatusCode switch
        {
            HttpStatusCode.Unauthorized => ApiFailure.SessionExpired,
            HttpStatusCode.Forbidden when isLogin => ClassifyLoginRefusal(detail),
            HttpStatusCode.Forbidden => ApiFailure.Forbidden,
            HttpStatusCode.NotFound => ApiFailure.NotFound,
            HttpStatusCode.Conflict => ApiFailure.Conflict,
            HttpStatusCode.TooManyRequests => ApiFailure.RateLimited,
            HttpStatusCode.BadRequest => ApiFailure.Invalid,
            _ => status >= 500 ? ApiFailure.ServerError : ApiFailure.Invalid
        }
        };

        string message = failure switch
        {
            ApiFailure.Unreachable =>
                "The connection to the support server was lost before it answered. Try again.",
            ApiFailure.SessionExpired =>
                "Your session has expired. Sign in again to continue.",
            ApiFailure.RateLimited =>
                "Too many attempts. Wait a minute before trying again.",
            ApiFailure.ServerError =>
                detail is { Length: > 0 }
                    ? detail
                    : "The server reported an internal error. Nothing was changed.",
            _ => detail is { Length: > 0 } ? detail : DefaultMessage(status)
        };

        return new ApiException(failure, message, status);
    }

    /// <summary>
    /// A locked account and a wrong password both come back as 403, because the
    /// server refuses to let an unauthenticated caller enumerate accounts. The
    /// wording is the only signal, and the two need telling apart on screen —
    /// "wait fifteen minutes" and "check your password" are different advice.
    /// An unrecognised wording falls back to the credential case, which is the
    /// safe way round: it tells the user nothing they did not already provide.
    /// </summary>
    private static ApiFailure ClassifyLoginRefusal(string? detail) =>
        detail is { Length: > 0 } && detail.Contains("lock", StringComparison.OrdinalIgnoreCase)
            ? ApiFailure.AccountLocked
            : ApiFailure.InvalidCredentials;

    private static async Task<string?> TryReadProblemDetailAsync(
        HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            using JsonDocument document = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);

            JsonElement root = document.RootElement;

            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (root.TryGetProperty("detail", out JsonElement detail) &&
                detail.ValueKind == JsonValueKind.String)
            {
                return detail.GetString();
            }

            // Model-binding failures arrive as a ProblemDetails with an errors
            // dictionary and no detail. Flattening it is what lets the dialog
            // say which field the server objected to.
            if (root.TryGetProperty("errors", out JsonElement errors) &&
                errors.ValueKind == JsonValueKind.Object)
            {
                List<string> messages = new();

                foreach (JsonProperty property in errors.EnumerateObject())
                {
                    if (property.Value.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    messages.AddRange(property.Value
                        .EnumerateArray()
                        .Where(m => m.ValueKind == JsonValueKind.String)
                        .Select(m => m.GetString()!)
                        .Where(m => !string.IsNullOrWhiteSpace(m)));
                }

                if (messages.Count > 0)
                {
                    return string.Join(" ", messages);
                }
            }

            if (root.TryGetProperty("title", out JsonElement title) &&
                title.ValueKind == JsonValueKind.String)
            {
                return title.GetString();
            }

            return null;
        }
        catch (JsonException)
        {
            // A body that is not ProblemDetails — an HTML error page from a
            // proxy, most likely. The status code still classifies the failure.
            return null;
        }
    }

    private static string DefaultMessage(int status) => status switch
    {
        403 => "You are not permitted to do that.",
        404 => "That item no longer exists.",
        409 => "That conflicts with the current state. Refresh and try again.",
        _ => $"The request was refused (HTTP {status})."
    };
}
