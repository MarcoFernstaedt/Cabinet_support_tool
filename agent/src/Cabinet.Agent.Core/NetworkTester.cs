using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core;

/// <summary>The network facts network.test needs, in the order Windows lists the adapters.</summary>
public sealed record AdapterFacts(bool Connected, IReadOnlyList<IPAddress> Gateways, IReadOnlyList<IPAddress> DnsServers);

/// <summary>
/// network.test: ping, DNS lookup or TCP connect to one of four target kinds,
/// each resolved from the cabinet's own configuration or network settings.
/// There is no way to name an arbitrary host, so the test cannot be used to
/// scan a client's network. A DNS test always looks up the platform server's
/// host name. TCP ports are limited by the validator to the local allow list.
/// </summary>
public sealed class NetworkTester
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    private readonly AgentConfig _config;
    private readonly Func<IReadOnlyList<AdapterFacts>> _adapters;

    public NetworkTester(AgentConfig config, Func<IReadOnlyList<AdapterFacts>>? adapters = null)
    {
        _config = config;
        _adapters = adapters ?? CurrentAdapters;
    }

    public async Task<NetworkTestOutput> RunAsync(NetworkTestParams p, CancellationToken token)
    {
        NetworkTestOutput Result(bool ok, IPAddress? target, double? ms, IReadOnlyList<IPAddress>? resolved, string? error) => new()
        {
            Target = p.Target, Method = p.Method, ResolvedTarget = target?.ToString(), Success = ok,
            LatencyMs = ms is null ? null : Math.Round(ms.Value, 1),
            ResolvedAddresses = (resolved ?? Array.Empty<IPAddress>()).Take(16).Select(a => a.ToString()).ToList(),
            Error = error is null ? null : EventText.ShortText(error),
        };

        // Where the test goes: an address from this cabinet's settings, or a configured name.
        IPAddress? address;
        string? name;
        switch (p.Target)
        {
            case NetworkTestTarget.Gateway:
                address = _adapters().Where(a => a.Connected).SelectMany(a => a.Gateways).FirstOrDefault();
                if (address is null) return Result(false, null, null, null, "This cabinet has no default gateway on a connected adapter.");
                name = null;
                break;
            case NetworkTestTarget.DnsServer:
                var servers = _adapters().Where(a => a.Connected).SelectMany(a => a.DnsServers).Distinct().ToList();
                if (p.DnsServerIndex!.Value >= servers.Count)
                    return Result(false, null, null, null, $"This cabinet has {servers.Count} DNS server(s) configured; there is no server {p.DnsServerIndex.Value + 1}.");
                address = servers[p.DnsServerIndex.Value];
                name = null;
                break;
            case NetworkTestTarget.SyncCabinet:
                (address, name) = Parse(_config.SyncCabinet.Address);
                if (address is null && name is null) throw new OperationFailedException("unavailable", "The sync cabinet's address is not configured on this cabinet yet.");
                break;
            default:
                (address, name) = Parse(_config.PlatformServer.Host);
                if (address is null && name is null) throw new OperationFailedException("unavailable", "The platform server's host name is not configured on this cabinet yet.");
                break;
        }

        if (p.Method == NetworkTestMethod.Dns)
        {
            if (p.Target is NetworkTestTarget.Gateway or NetworkTestTarget.DnsServer)
            {
                // Ask that server directly for the platform server's name.
                string? lookup = _config.PlatformServer.Host;
                if (lookup is null || IPAddress.TryParse(lookup, out _))
                    throw new OperationFailedException("unavailable", "There is no platform server host name configured to look up.");
                var watch = Stopwatch.StartNew();
                try
                {
                    DnsWire.Answer? answer = await DnsWire.QueryAsync(address!, lookup, Timeout, token).ConfigureAwait(false);
                    double ms = watch.Elapsed.TotalMilliseconds;
                    if (answer is null) return Result(false, address, null, null, "The DNS server sent a malformed answer.");
                    if (answer.ResponseCode != 0) return Result(false, address, ms, null, $"The lookup failed: {DnsWire.RcodeText(answer.ResponseCode)}.");
                    return answer.Addresses.Count == 0
                        ? Result(false, address, ms, null, "The DNS server answered with no IPv4 address.")
                        : Result(true, address, ms, answer.Addresses, null);
                }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    return Result(false, address, null, null, "The DNS server did not answer within 5 seconds.");
                }
                catch (SocketException e)
                {
                    return Result(false, address, null, null, $"The DNS query could not be sent ({e.SocketErrorCode}).");
                }
            }
            if (name is null) return Result(true, address, 0, new[] { address! }, null);
            var (resolved, resolveMs, resolveError) = await ResolveAsync(name, token).ConfigureAwait(false);
            return resolveError is null ? Result(true, null, resolveMs, resolved, null) : Result(false, null, resolveMs, null, resolveError);
        }

        // Ping and TCP need an address; a configured name is resolved by the system resolver first.
        IReadOnlyList<IPAddress>? names = null;
        if (address is null)
        {
            var (resolved, _, resolveError) = await ResolveAsync(name!, token).ConfigureAwait(false);
            if (resolveError is not null) return Result(false, null, null, null, resolveError);
            names = resolved;
            address = resolved[0];
        }

        if (p.Method == NetworkTestMethod.Ping)
        {
            using var ping = new Ping();
            try
            {
                PingReply reply = await ping.SendPingAsync(address, Timeout, cancellationToken: token).ConfigureAwait(false);
                return reply.Status == IPStatus.Success
                    ? Result(true, address, reply.RoundtripTime, names, null)
                    : Result(false, address, null, names, $"No reply ({reply.Status}).");
            }
            catch (PingException)
            {
                return Result(false, address, null, names, "The ping could not be sent.");
            }
        }

        using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(Timeout);
        var connectWatch = Stopwatch.StartNew();
        try
        {
            await socket.ConnectAsync(new IPEndPoint(address, p.Port!.Value), limit.Token).ConfigureAwait(false);
            return Result(true, address, connectWatch.Elapsed.TotalMilliseconds, names, null);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            return Result(false, address, null, names, $"No answer on TCP port {p.Port} within 5 seconds.");
        }
        catch (SocketException e)
        {
            return Result(false, address, null, names, e.SocketErrorCode == SocketError.ConnectionRefused
                ? $"TCP port {p.Port} refused the connection."
                : $"TCP port {p.Port} could not be reached ({e.SocketErrorCode}).");
        }
    }

    private static (IPAddress? Address, string? Name) Parse(string? configured) =>
        configured is null ? (null, null) : IPAddress.TryParse(configured, out IPAddress? ip) ? (ip, null) : (null, configured);

    private static async Task<(IReadOnlyList<IPAddress> Addresses, double? Ms, string? Error)> ResolveAsync(string name, CancellationToken token)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(Timeout);
        var watch = Stopwatch.StartNew();
        try
        {
            IPAddress[] found = await Dns.GetHostAddressesAsync(name, limit.Token).ConfigureAwait(false);
            double ms = watch.Elapsed.TotalMilliseconds;
            return found.Length == 0 ? (Array.Empty<IPAddress>(), ms, "The name resolved to no addresses.") : (found, ms, null);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            return (Array.Empty<IPAddress>(), null, "The name lookup did not finish within 5 seconds.");
        }
        catch (SocketException e)
        {
            return (Array.Empty<IPAddress>(), watch.Elapsed.TotalMilliseconds, $"The name could not be resolved ({e.SocketErrorCode}).");
        }
    }

    /// <summary>The adapters as the operating system reports them.</summary>
    public static IReadOnlyList<AdapterFacts> CurrentAdapters() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .Select(n =>
            {
                IPInterfaceProperties props = n.GetIPProperties();
                return new AdapterFacts(
                    n.OperationalStatus == OperationalStatus.Up,
                    props.GatewayAddresses.Select(g => g.Address).Where(a => !a.Equals(IPAddress.Any) && !a.Equals(IPAddress.IPv6Any)).ToList(),
                    props.DnsAddresses.ToList());
            })
            .ToList();
}
