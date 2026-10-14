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
                // The site's setting from the console (already checked to be on this cabinet's network), else the local configuration.
                (address, name) = Parse(p.SyncAddress ?? _config.SyncCabinet.Address);
                if (address is null && name is null) throw new OperationFailedException("unavailable", "The sync cabinet's address is not set for this site or cabinet yet.");
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

        if (p.Method == NetworkTestMethod.Ping && p.Count is > 1)
            return await PingSeriesAsync(address, names, p.Count.Value, Result, token).ConfigureAwait(false);

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

        if (p.Count is > 1) return await TcpSeriesAsync(address, p.Port!.Value, p.Count.Value, names, Result, token).ConfigureAwait(false);

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

    /// <summary>Several echo requests in a row: how many came back, how fast, and how much the times jump around.</summary>
    private static async Task<NetworkTestOutput> PingSeriesAsync(IPAddress address, IReadOnlyList<IPAddress>? names, int count,
        Func<bool, IPAddress?, double?, IReadOnlyList<IPAddress>?, string?, NetworkTestOutput> result, CancellationToken token)
    {
        var times = new List<double>();
        IPStatus lastFailure = IPStatus.Success;
        using var ping = new Ping();
        for (int i = 0; i < count; i++)
        {
            token.ThrowIfCancellationRequested();
            var watch = Stopwatch.StartNew();
            try
            {
                PingReply reply = await ping.SendPingAsync(address, Timeout, cancellationToken: token).ConfigureAwait(false);
                if (reply.Status == IPStatus.Success) times.Add(watch.Elapsed.TotalMilliseconds); else lastFailure = reply.Status;
            }
            catch (PingException) { lastFailure = IPStatus.Unknown; }
            if (i < count - 1) await Task.Delay(100, token).ConfigureAwait(false);
        }
        PingStatistics stats = Summarize(count, times);
        NetworkTestOutput basis = times.Count > 0
            ? result(true, address, stats.AvgMs, names, null)
            : result(false, address, null, names, $"No reply to any of {count} requests ({lastFailure}).");
        return basis with { Statistics = stats };
    }

    /// <summary>
    /// Several TCP connections in a row to one port: how many were made, how long each took and how much that jumps around. Built for weak links
    /// (a satellite on poor Wi-Fi) where one try says little: the output separates "never answers" from "answers some of the time".
    /// </summary>
    private static async Task<NetworkTestOutput> TcpSeriesAsync(IPAddress address, int port, int count, IReadOnlyList<IPAddress>? names,
        Func<bool, IPAddress?, double?, IReadOnlyList<IPAddress>?, string?, NetworkTestOutput> result, CancellationToken token)
    {
        var times = new List<double>();
        string? lastFailure = null;
        for (int i = 0; i < count; i++)
        {
            token.ThrowIfCancellationRequested();
            using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(TimeSpan.FromSeconds(2));
            var watch = Stopwatch.StartNew();
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, port), limit.Token).ConfigureAwait(false);
                times.Add(watch.Elapsed.TotalMilliseconds);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { lastFailure = $"No answer on TCP port {port} within 2 seconds."; }
            catch (SocketException e) { lastFailure = e.SocketErrorCode == SocketError.ConnectionRefused ? $"TCP port {port} refused the connection." : $"TCP port {port} could not be reached ({e.SocketErrorCode})."; }
            if (i < count - 1) await Task.Delay(300, token).ConfigureAwait(false);
        }
        PingStatistics stats = Summarize(count, times);
        NetworkTestOutput basis = times.Count > 0
            ? result(true, address, stats.AvgMs, names, null)
            : result(false, address, null, names, lastFailure ?? $"TCP port {port} did not answer.");
        return basis with { Statistics = stats };
    }

    /// <summary>Loss, fastest, average, slowest and jitter (the average gap between one reply's time and the next) of a series of pings.</summary>
    public static PingStatistics Summarize(int sent, IReadOnlyList<double> times)
    {
        double? Round(double? v) => v is null ? null : Math.Round(v.Value, 1);
        double jitter = times.Count > 1 ? times.Zip(times.Skip(1), (a, b) => Math.Abs(b - a)).Average() : 0;
        return new PingStatistics
        {
            Sent = sent, Received = times.Count, LossPercent = Math.Round(100.0 * (sent - times.Count) / sent, 1),
            MinMs = times.Count > 0 ? Round(times.Min()) : null, AvgMs = times.Count > 0 ? Round(times.Average()) : null,
            MaxMs = times.Count > 0 ? Round(times.Max()) : null, JitterMs = times.Count > 1 ? Round(jitter) : times.Count == 1 ? 0 : null,
        };
    }

    /// <summary>
    /// network.trace: the route to one of the four fixed target kinds, found with echo requests of rising time-to-live, sent by the
    /// agent itself (no external program). Three probes a hop, a second each; it stops at the target, at the hop limit, or after four hops in
    /// a row that never answer, so a trace takes at most about a minute.
    /// </summary>
    public async Task<NetworkTraceOutput> TraceAsync(NetworkTraceParams p, CancellationToken token)
    {
        NetworkTraceOutput Out(IPAddress? target, bool reached, IReadOnlyList<TraceHop> hops, string? error) => new()
        { Target = p.Target, ResolvedTarget = target?.ToString(), Reached = reached, Hops = hops, Error = error is null ? null : EventText.ShortText(error) };

        IPAddress? address;
        string? name = null;
        switch (p.Target)
        {
            case NetworkTestTarget.Gateway:
                address = _adapters().Where(a => a.Connected).SelectMany(a => a.Gateways).FirstOrDefault();
                if (address is null) return Out(null, false, Array.Empty<TraceHop>(), "This cabinet has no default gateway on a connected adapter.");
                break;
            case NetworkTestTarget.DnsServer:
                var servers = _adapters().Where(a => a.Connected).SelectMany(a => a.DnsServers).Distinct().ToList();
                if (p.DnsServerIndex!.Value >= servers.Count)
                    return Out(null, false, Array.Empty<TraceHop>(), $"This cabinet has {servers.Count} DNS server(s) configured; there is no server {p.DnsServerIndex.Value + 1}.");
                address = servers[p.DnsServerIndex.Value];
                break;
            case NetworkTestTarget.SyncCabinet:
                (address, name) = Parse(p.SyncAddress ?? _config.SyncCabinet.Address);
                if (address is null && name is null) throw new OperationFailedException("unavailable", "The sync cabinet's address is not set for this site or cabinet yet.");
                break;
            default:
                (address, name) = Parse(_config.PlatformServer.Host);
                if (address is null && name is null) throw new OperationFailedException("unavailable", "The platform server's host name is not configured on this cabinet yet.");
                break;
        }
        if (address is null)
        {
            var (resolved, _, resolveError) = await ResolveAsync(name!, token).ConfigureAwait(false);
            if (resolveError is not null) return Out(null, false, Array.Empty<TraceHop>(), resolveError);
            address = resolved.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork) ?? resolved[0];
        }
        if (address.AddressFamily != AddressFamily.InterNetwork) return Out(address, false, Array.Empty<TraceHop>(), "Only IPv4 targets can be traced.");

        int max = p.MaxHops ?? 12;
        var hops = new List<TraceHop>();
        int silent = 0;
        using var ping = new Ping();
        byte[] payload = new byte[32];
        for (int hop = 1; hop <= max; hop++)
        {
            var times = new List<double?>();
            IPAddress? seen = null;
            bool reached = false;
            for (int probe = 0; probe < 3; probe++)
            {
                token.ThrowIfCancellationRequested();
                var watch = Stopwatch.StartNew();
                try
                {
                    PingReply reply = await ping.SendPingAsync(address, TimeSpan.FromSeconds(1), payload, new PingOptions(hop, true), token).ConfigureAwait(false);
                    if (reply.Status is IPStatus.TtlExpired or IPStatus.TimeExceeded or IPStatus.Success)
                    {
                        seen ??= reply.Address;
                        times.Add(Math.Round(watch.Elapsed.TotalMilliseconds, 1));
                        if (reply.Status == IPStatus.Success) reached = true;
                    }
                    else times.Add(null);
                }
                catch (PingException) { times.Add(null); }
            }
            hops.Add(new TraceHop { Hop = hop, Address = seen?.ToString(), RttMs = times });
            if (reached) return Out(address, true, hops, null);
            silent = seen is null ? silent + 1 : 0;
            if (silent >= 4) break;
        }
        return Out(address, false, hops, hops.Count >= max ? $"The target was not reached within {max} hops." : $"No reply after hop {hops.Count - silent}.");
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
