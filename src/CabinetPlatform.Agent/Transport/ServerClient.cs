using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// Talks to the support server over HTTPS.
/// </summary>
/// <remarks>
/// The agent makes no authorization decisions of its own here. It reports what
/// it found and asks what it should do; every "may this happen" question is the
/// server's to answer, and a refusal from the server is simply obeyed.
/// </remarks>
public sealed class ServerClient : IServerClient
{
    private const string RegisterPath = "api/agent/register";
    private const string CheckInPath = "api/agent/checkin";
    private const string FullCheckInPath = "api/agent/checkin/full";
    private const string ActionsPath = "api/agent/actions";
    private const string ActionResultPath = "api/agent/actions/result";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ServerClient> _logger;

    public ServerClient(IHttpClientFactory httpClientFactory, ILogger<ServerClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<RegistrationResponse?> RegisterAsync(
        RegistrationRequest request,
        CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient(AgentHttpClients.Server);

        try
        {
            using var response = await client
                .PostAsJsonAsync(RegisterPath, request, AgentJson.SerializerOptions, cancellationToken)
                .ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "Registration was refused with {StatusCode}.",
                    (int)response.StatusCode);
                return null;
            }

            return await response.Content
                .ReadFromJsonAsync<RegistrationResponse>(AgentJson.SerializerOptions, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (IsTransportFailure(e))
        {
            _logger.LogWarning(e, "Registration could not reach the server.");
            return null;
        }
    }

    public async Task<CheckInResult> CheckInAsync(
        CheckInPayload payload, CheckInTier tier, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient(AgentHttpClients.Server);

        // The tier is the route, never a field in the body. An agent cannot
        // talk the server into storing its heavy sections by claiming a tier.
        string path = tier == CheckInTier.Full ? FullCheckInPath : CheckInPath;

        try
        {
            using var response = await client
                .PostAsJsonAsync(path, payload, AgentJson.SerializerOptions, cancellationToken)
                .ConfigureAwait(false);

            return await InterpretCheckInResponseAsync(response, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (IsTransportFailure(e))
        {
            _logger.LogDebug(e, "The check-in could not reach the server.");

            return new CheckInResult
            {
                Outcome = CheckInOutcome.Failed,
                Detail = e.Message,
            };
        }
    }

    /// <summary>
    /// Turns the server's status code into the agent's next move.
    /// </summary>
    /// <remarks>
    /// The distinction that matters is between "try again later" and "trying
    /// again cannot help". A network failure is worth spooling; a payload the
    /// server calls malformed will be just as malformed in an hour, and keeping
    /// it would block the spool behind it.
    /// </remarks>
    private async Task<CheckInResult> InterpretCheckInResponseAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            Guid? cabinetId = null;

            // The server issues the cabinet id on every accepted check-in,
            // which is how an agent approved while it was offline learns its
            // own identity without a separate round trip.
            if (response.Content.Headers.ContentLength is > 0)
            {
                try
                {
                    var body = await response.Content
                        .ReadFromJsonAsync<CheckInResponse>(AgentJson.SerializerOptions, cancellationToken)
                        .ConfigureAwait(false);

                    cabinetId = body?.CabinetId;
                }
                catch (Exception e) when (e is System.Text.Json.JsonException or NotSupportedException)
                {
                    // A body the agent does not understand does not invalidate
                    // an accepted check-in.
                    _logger.LogDebug(e, "The check-in response body could not be read.");
                }
            }

            return new CheckInResult { Outcome = CheckInOutcome.Accepted, CabinetId = cabinetId };
        }

        return response.StatusCode switch
        {
            // The cabinet is known but not yet approved by a human.
            HttpStatusCode.Forbidden => new CheckInResult { Outcome = CheckInOutcome.NotApproved },

            // The server has no record of this machine id at all.
            HttpStatusCode.NotFound or HttpStatusCode.Unauthorized =>
                new CheckInResult { Outcome = CheckInOutcome.NotRegistered },

            HttpStatusCode.BadRequest or HttpStatusCode.UnprocessableEntity =>
                new CheckInResult
                {
                    Outcome = CheckInOutcome.Rejected,
                    Detail = $"The server rejected the payload with {(int)response.StatusCode}.",
                },

            _ => new CheckInResult
            {
                Outcome = CheckInOutcome.Failed,
                Detail = $"The server returned {(int)response.StatusCode}.",
            },
        };
    }

    public async Task<IReadOnlyList<ActionRequestDto>> GetPendingActionsAsync(
        Guid cabinetId,
        CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient(AgentHttpClients.Server);

        try
        {
            // The cabinet is resolved server-side from the authenticated
            // machine identity. Sending an id here would be the agent naming
            // whose work it wants, which is not its decision to make.
            _ = cabinetId;

            var actions = await client
                .GetFromJsonAsync<IReadOnlyList<ActionRequestDto>>(
                    ActionsPath, AgentJson.SerializerOptions, cancellationToken)
                .ConfigureAwait(false);

            return actions ?? Array.Empty<ActionRequestDto>();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (System.Text.Json.JsonException e)
        {
            // An ActionName outside the catalog cannot be deserialised, which
            // is the contract doing its job. Nothing runs and the agent says so.
            _logger.LogWarning(
                e,
                "The action list could not be deserialised and was ignored. " +
                "An action outside the agent's catalog cannot be represented and will never run.");
            return Array.Empty<ActionRequestDto>();
        }
        catch (Exception e) when (IsTransportFailure(e))
        {
            _logger.LogDebug(e, "Pending actions could not be fetched.");
            return Array.Empty<ActionRequestDto>();
        }
    }

    public async Task<bool> ReportActionResultAsync(ActionResultDto result, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient(AgentHttpClients.Server);

        try
        {
            using var response = await client
                .PostAsJsonAsync(ActionResultPath, result, AgentJson.SerializerOptions, cancellationToken)
                .ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "Reporting the result of action {RequestId} returned {StatusCode}.",
                    result.RequestId,
                    (int)response.StatusCode);
                return false;
            }

            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (IsTransportFailure(e))
        {
            _logger.LogWarning(e, "The result of action {RequestId} could not be reported.", result.RequestId);
            return false;
        }
    }

    /// <summary>
    /// Whether an exception is the network being unavailable rather than a bug.
    /// </summary>
    private static bool IsTransportFailure(Exception exception)
        => exception is HttpRequestException
            or TaskCanceledException
            or OperationCanceledException
            or IOException
            or System.Net.Sockets.SocketException;
}
