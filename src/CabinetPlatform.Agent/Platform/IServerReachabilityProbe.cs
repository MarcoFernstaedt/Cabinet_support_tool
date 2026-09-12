using System.Diagnostics;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Platform;

/// <summary>One reachability measurement.</summary>
/// <param name="Reachable">
/// Whether the server answered. <see langword="null"/> means the probe could
/// not be attempted at all — no configured server address — which is not the
/// same as a server that did not answer.
/// </param>
/// <param name="LatencyMs">Round-trip time, when there was one.</param>
public readonly record struct ServerReachability(bool? Reachable, double? LatencyMs);

/// <summary>
/// Asks whether this cabinet can currently reach the support server.
/// </summary>
/// <remarks>
/// Its own service because two very different callers need exactly the same
/// answer: the network collector, which reports reachability on every check-in,
/// and the confirm-or-revert path, for which this measurement is the whole
/// safety mechanism. Two implementations would eventually disagree, and the one
/// that disagreed would strand a cabinet.
/// </remarks>
public interface IServerReachabilityProbe
{
    /// <summary>Probes the server once, under the configured timeout.</summary>
    /// <param name="cancellationToken">Cancels the probe.</param>
    Task<ServerReachability> ProbeAsync(CancellationToken cancellationToken);
}

/// <summary>Probes with a HEAD request to the server's base address.</summary>
public sealed class ServerReachabilityProbe : IServerReachabilityProbe
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly AgentOptions _options;
    private readonly ILogger<ServerReachabilityProbe> _logger;

    /// <summary>Creates the probe.</summary>
    /// <param name="httpClientFactory">Supplies the short-timeout probe client.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public ServerReachabilityProbe(
        IHttpClientFactory httpClientFactory,
        IOptions<AgentOptions> options,
        ILogger<ServerReachabilityProbe> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options.Value;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task<ServerReachability> ProbeAsync(CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(_options.ServerBaseUrl, UriKind.Absolute, out Uri? serverUri))
        {
            return new ServerReachability(null, null);
        }

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(
            TimeSpan.FromSeconds(_options.Collection.ServerReachabilityTimeoutSeconds));

        HttpClient client = _httpClientFactory.CreateClient(AgentHttpClients.Probe);
        using var request = new HttpRequestMessage(HttpMethod.Head, serverUri);

        var stopwatch = Stopwatch.StartNew();

        try
        {
            using HttpResponseMessage response = await client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token)
                .ConfigureAwait(false);

            stopwatch.Stop();

            // Any HTTP response proves the network path and the listener. A 404
            // on the base address is still a reachable server.
            return new ServerReachability(true, Math.Round(stopwatch.Elapsed.TotalMilliseconds, 2));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException)
        {
            stopwatch.Stop();
            _logger.LogDebug(e, "The server reachability probe to {ServerUri} failed.", serverUri);

            // Unreachable is a real measurement, not a missing one, so it is
            // reported as false with no latency.
            return new ServerReachability(false, null);
        }
    }
}
