using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Users;

namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// The only place in the console that speaks HTTP.
/// </summary>
public sealed class ApiClient : IApiClient
{
    private static readonly JsonSerializerOptions Json = ContractJson.CreateOptions();

    private readonly HttpClient _http;
    private readonly ISessionStore _session;

    public ApiClient(HttpClient http, ISessionStore session)
    {
        _http = http;
        _session = session;
    }

    // --- Authentication --------------------------------------------------

    public async Task<LoginResponse> LoginAsync(LoginRequest request, CancellationToken ct)
    {
        LoginResponse response = await PostAsync<LoginRequest, LoginResponse>(
            "api/auth/login", request, isLogin: true, ct);

        _session.SignIn(
            response.AccessToken,
            response.ExpiresUtc,
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

    // --- Cabinets --------------------------------------------------------

    public Task<PagedResult<CabinetSummary>> GetCabinetsAsync(CabinetQuery query, CancellationToken ct)
    {
        string url = "api/cabinets" + new QueryString()
            .Add("clientName", query.ClientName)
            .Add("siteName", query.SiteName)
            .Add("search", query.Search)
            .Add("isActive", query.IsActive)
            .Add("health", query.Health)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<CabinetSummary>>(url, ct);
    }

    public Task<CabinetLatestDto> GetCabinetLatestAsync(Guid cabinetId, CancellationToken ct) =>
        GetAsync<CabinetLatestDto>($"api/cabinets/{cabinetId:D}/latest", ct);

    public Task<PagedResult<CheckInSummaryDto>> GetCheckInHistoryAsync(
        Guid cabinetId, HistoryQuery query, CancellationToken ct)
    {
        string url = $"api/cabinets/{cabinetId:D}/history" + new QueryString()
            .Add("fromUtc", query.FromUtc)
            .Add("toUtc", query.ToUtc)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<CheckInSummaryDto>>(url, ct);
    }

    public Task<PagedResult<SmartReadingDto>> GetSmartHistoryAsync(
        Guid cabinetId, SmartHistoryQuery query, CancellationToken ct)
    {
        string url = $"api/cabinets/{cabinetId:D}/smart-history" + new QueryString()
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

    public Task<ActionRequestDto> CreateActionAsync(CreateActionRequest request, CancellationToken ct) =>
        PostAsync<CreateActionRequest, ActionRequestDto>("api/actions", request, isLogin: false, ct);

    public Task<ActionRequestDto> GetActionAsync(Guid actionId, CancellationToken ct) =>
        GetAsync<ActionRequestDto>($"api/actions/{actionId:D}", ct);

    public Task<PagedResult<ActionRequestDto>> GetActionsAsync(ActionQuery query, CancellationToken ct)
    {
        string url = "api/actions" + new QueryString()
            .Add("cabinetId", query.CabinetId)
            .Add("status", query.Status)
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<ActionRequestDto>>(url, ct);
    }

    public Task<PagedResult<ActionRequestDto>> GetPendingApprovalsAsync(PagedQuery query, CancellationToken ct)
    {
        string url = "api/actions/pending-approval" + new QueryString()
            .Add("page", query.Page)
            .Add("pageSize", query.PageSize);

        return GetAsync<PagedResult<ActionRequestDto>>(url, ct);
    }

    public Task<ActionRequestDto> ApproveActionAsync(
        Guid actionId, ApproveActionRequest request, CancellationToken ct) =>
        PostAsync<ApproveActionRequest, ActionRequestDto>(
            $"api/actions/{actionId:D}/approve", request, isLogin: false, ct);

    public Task<ActionRequestDto> DenyActionAsync(
        Guid actionId, DenyActionRequest request, CancellationToken ct) =>
        PostAsync<DenyActionRequest, ActionRequestDto>(
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

    // --- Transport -------------------------------------------------------

    private async Task<T> GetAsync<T>(string url, CancellationToken ct)
    {
        using HttpResponseMessage response = await SendAsync(
            () => new HttpRequestMessage(HttpMethod.Get, url), ct);

        return await ReadAsync<T>(response, isLogin: false, ct);
    }

    private async Task<TResponse> PostAsync<TRequest, TResponse>(
        string url, TRequest body, bool isLogin, CancellationToken ct)
    {
        using HttpResponseMessage response = await SendAsync(
            () => new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = JsonContent.Create(body, options: Json)
            },
            ct);

        return await ReadAsync<TResponse>(response, isLogin, ct);
    }

    private async Task PostAsync<TRequest>(string url, TRequest body, CancellationToken ct)
    {
        using HttpResponseMessage response = await SendAsync(
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
        using HttpRequestMessage request = requestFactory();

        try
        {
            HttpResponseMessage response = await _http.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, ct);

            // A cancelled call does not get to produce an error message. Whether
            // the cancellation raced the response or the server noticed the
            // disconnect and answered 499, the user navigated away — and telling
            // them the request was refused would be false.
            ct.ThrowIfCancellationRequested();

            return response;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
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
            T? value = await response.Content.ReadFromJsonAsync<T>(Json, ct);

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

    /// <summary>
    /// Maps a failure response to an <see cref="ApiException"/>, preferring the
    /// server's own <c>ProblemDetails.detail</c> as the message.
    /// </summary>
    private static async Task<ApiException> ToExceptionAsync(
        HttpResponseMessage response, bool isLogin, CancellationToken ct)
    {
        int status = (int)response.StatusCode;
        string? detail = await TryReadProblemDetailAsync(response, ct);

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
        catch (Exception ex) when (ex is JsonException or NotSupportedException or IOException)
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
