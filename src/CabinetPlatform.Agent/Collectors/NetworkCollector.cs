using System.Diagnostics;
using System.Net.Http;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Adapters, addressing, firewall profiles, proxy configuration and whether the
/// support server can actually be reached.
/// </summary>
/// <remarks>
/// The reachability probe is the point of this section. When a cabinet is
/// checking in, the probe is redundant; its value is in the payloads that spool
/// to disk during an outage and arrive afterwards, which is when someone needs
/// to know whether the cabinet could see the server, and how slowly.
/// </remarks>
public sealed class NetworkCollector : ICollector
{
    private const string InternetSettingsKey =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings";

    private readonly INetworkInterfaceProvider _adapters;
    private readonly IWmiRepository _wmi;
    private readonly IRegistryReader _registry;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly AgentOptions _options;
    private readonly ILogger<NetworkCollector> _logger;

    public NetworkCollector(
        INetworkInterfaceProvider adapters,
        IWmiRepository wmi,
        IRegistryReader registry,
        IHttpClientFactory httpClientFactory,
        IOptions<AgentOptions> options,
        ILogger<NetworkCollector> logger)
    {
        _adapters = adapters;
        _wmi = wmi;
        _registry = registry;
        _httpClientFactory = httpClientFactory;
        _options = options.Value;
        _logger = logger;
    }

    public string SectionName => CollectorSections.Network;

    /// <inheritdoc />
    public bool RunsOnHeartbeat => false;

    public async Task CollectAsync(CheckInDraft draft, CheckInTier tier, CancellationToken cancellationToken)
    {
        var firewall = ReadFirewallProfiles();
        var (proxyConfigured, proxyAddress) = ReadProxy();
        var (reachable, latencyMs) = await ProbeServerAsync(cancellationToken).ConfigureAwait(false);

        draft.Network = new NetworkInfo
        {
            Adapters = _adapters.GetAdapters(),
            ProxyConfigured = proxyConfigured,
            ProxyAddress = proxyAddress,
            FirewallDomainEnabled = firewall.GetValueOrDefault("Domain"),
            FirewallPrivateEnabled = firewall.GetValueOrDefault("Private"),
            FirewallPublicEnabled = firewall.GetValueOrDefault("Public"),
            ServerReachable = reachable,
            ServerLatencyMs = latencyMs,
        };
    }

    /// <summary>
    /// Reads the three firewall profiles' enabled state.
    /// </summary>
    /// <remarks>
    /// <c>MSFT_NetFirewallProfile</c> reports each profile's name and whether it
    /// is enabled. A cabinet with the domain profile off is a finding in its own
    /// right on a DEA-regulated machine.
    /// </remarks>
    private Dictionary<string, bool?> ReadFirewallProfiles()
    {
        var profiles = new Dictionary<string, bool?>(StringComparer.OrdinalIgnoreCase);

        try
        {
            foreach (var row in _wmi.Query(
                         WmiScopes.StandardCimV2,
                         "SELECT Name, Enabled FROM MSFT_NetFirewallProfile"))
            {
                var name = row.GetString("Name");
                if (name is null)
                {
                    continue;
                }

                // Enabled is a UInt16 where 1 is true and 2 is false, not a
                // boolean; a plain truthiness test would report every profile on.
                var enabled = row.GetInt32("Enabled");
                profiles[name] = enabled switch
                {
                    1 => true,
                    2 => false,
                    _ => row.GetBoolean("Enabled"),
                };
            }
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Firewall profile state could not be read.");
        }

        return profiles;
    }

    /// <summary>
    /// Reads the machine-wide WinINET proxy configuration.
    /// </summary>
    /// <remarks>
    /// The machine hive is read rather than the interactive user's, because the
    /// agent runs as LocalSystem with no interactive session and it is the
    /// machine's proxy that governs its own check-ins.
    /// </remarks>
    private (bool? Configured, string? Address) ReadProxy()
    {
        var proxyEnable = _registry.GetValue(
            RegistryHiveScope.LocalMachine,
            InternetSettingsKey,
            "ProxyEnable",
            RegistryViewScope.Registry64);

        var proxyServer = _registry.GetValue(
            RegistryHiveScope.LocalMachine,
            InternetSettingsKey,
            "ProxyServer",
            RegistryViewScope.Registry64) as string;

        bool? configured = null;
        if (proxyEnable is not null)
        {
            try
            {
                configured = Convert.ToInt32(proxyEnable, System.Globalization.CultureInfo.InvariantCulture) != 0;
            }
            catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
            {
                configured = null;
            }
        }

        if (configured is null && !string.IsNullOrWhiteSpace(proxyServer))
        {
            configured = true;
        }

        return (configured, string.IsNullOrWhiteSpace(proxyServer) ? null : proxyServer.Trim());
    }

    /// <summary>
    /// Sends a HEAD request to the server and measures the round trip.
    /// </summary>
    private async Task<(bool? Reachable, double? LatencyMs)> ProbeServerAsync(CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(_options.ServerBaseUrl, UriKind.Absolute, out var serverUri))
        {
            return (null, null);
        }

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(TimeSpan.FromSeconds(_options.Collection.ServerReachabilityTimeoutSeconds));

        var client = _httpClientFactory.CreateClient(AgentHttpClients.Probe);
        using var request = new HttpRequestMessage(HttpMethod.Head, serverUri);

        var stopwatch = Stopwatch.StartNew();

        try
        {
            using var response = await client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token)
                .ConfigureAwait(false);

            stopwatch.Stop();

            // Any HTTP response proves the network path and the listener. A 404
            // on the base address is still a reachable server.
            return (true, Math.Round(stopwatch.Elapsed.TotalMilliseconds, 2));
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
            return (false, null);
        }
    }
}
