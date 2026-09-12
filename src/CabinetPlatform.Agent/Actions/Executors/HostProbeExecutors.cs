using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Reads and checks the host a generic probe names.
/// </summary>
/// <remarks>
/// <para>
/// The cabinet-targeted probes take a cabinet id and let the server resolve the
/// address, which is by far the safer shape. These generic ones exist for the
/// other half of the job: "can this cabinet reach the practice management
/// server", "does DNS answer from here at all". The rep has to be able to name
/// that target, because the platform does not know about it.
/// </para>
/// <para>
/// So the value is checked rather than trusted. The server validates it too;
/// this is the agent's own check, and it refuses the classes of address that
/// answer nothing useful from a cabinet — loopback, link-local, multicast, the
/// unspecified address — rather than probing them.
/// </para>
/// </remarks>
internal static class HostTarget
{
    /// <summary>Reads the target host from the request.</summary>
    /// <param name="request">The action request.</param>
    /// <param name="host">The host, as a name or an address.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public static bool TryRead(ActionRequestDto request, out string host, out string failureReason)
    {
        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.TargetHost, out host, out failureReason))
        {
            return false;
        }

        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        {
            failureReason =
                "Probing localhost from a cabinet answers a question nobody asked. Name the host " +
                "the cabinet is failing to reach.";
            return false;
        }

        if (IPAddress.TryParse(host, out IPAddress? address) && !IsProbable(address, out failureReason))
        {
            return false;
        }

        failureReason = string.Empty;
        return true;
    }

    /// <summary>Whether a resolved address is one worth probing from a cabinet.</summary>
    /// <param name="address">The address.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public static bool IsProbable(IPAddress address, out string failureReason)
    {
        if (IPAddress.IsLoopback(address) ||
            address.Equals(IPAddress.Any) ||
            address.Equals(IPAddress.IPv6Any) ||
            address.Equals(IPAddress.Broadcast))
        {
            failureReason = "That address does not name another host.";
            return false;
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6 &&
            (address.IsIPv6Multicast || address.IsIPv6LinkLocal))
        {
            failureReason = "Multicast and link-local addresses do not name a host worth probing.";
            return false;
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            byte[] octets = address.GetAddressBytes();

            if (octets[0] >= 224)
            {
                failureReason = "Multicast and reserved addresses do not name a host worth probing.";
                return false;
            }

            if (octets[0] == 169 && octets[1] == 254)
            {
                failureReason =
                    "A link-local address is what a machine assigns itself when DHCP fails. It is " +
                    "not reachable from anywhere else.";
                return false;
            }
        }

        failureReason = string.Empty;
        return true;
    }
}

/// <summary>
/// Pings a named host or address from this cabinet.
/// </summary>
/// <remarks>
/// Through <see cref="Ping"/>, not by running <c>ping.exe</c>. The difference is
/// not stylistic: shelling out would give the agent a general mechanism for
/// launching programs, and the agent's safety rests on not having one.
/// </remarks>
public sealed class PingHostExecutor : IActionExecutor
{
    private const int AttemptCount = 4;
    private const int TimeoutMilliseconds = 2000;

    private readonly ILogger<PingHostExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="logger">Diagnostic log.</param>
    public PingHostExecutor(ILogger<PingHostExecutor> logger) => _logger = logger;

    /// <inheritdoc />
    public ActionName Action => ActionName.PingHost;

    /// <inheritdoc />
    public async Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, new[] { ActionParameterKeys.TargetHost }, out string unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        if (!HostTarget.TryRead(request, out string host, out string failure))
        {
            return ActionOutcome.Denied(failure);
        }

        using var ping = new Ping();
        var replies = new List<long>(AttemptCount);
        IPStatus lastStatus = IPStatus.Unknown;
        IPAddress? resolved = null;

        for (var attempt = 0; attempt < AttemptCount; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                PingReply reply = await ping
                    .SendPingAsync(host, TimeoutMilliseconds)
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);

                lastStatus = reply.Status;
                resolved ??= reply.Address;

                if (reply.Status == IPStatus.Success)
                {
                    replies.Add(reply.RoundtripTime);
                }
            }
            catch (PingException e)
            {
                // A name that does not resolve throws here. That is an answer —
                // "DNS does not know this host from the cabinet" — rather than
                // an executor failure, and it is reported as one.
                _logger.LogDebug(e, "The ping to {Host} failed.", host);

                return ActionOutcome.Failed(
                    $"'{host}' could not be pinged: {e.InnerException?.Message ?? e.Message}. " +
                    "If it is a name, this cabinet's DNS may not resolve it.");
            }
        }

        // The resolved address is reported alongside the name, because "it
        // resolves to the wrong address" is a different fault from "it does not
        // answer", and a rep needs to be able to tell them apart.
        string addressNote = resolved is null || resolved.Equals(IPAddress.None)
            ? string.Empty
            : $" ({resolved})";

        if (replies.Count == 0)
        {
            return ActionOutcome.Failed(
                $"'{host}'{addressNote} did not answer any of {AttemptCount} pings. " +
                $"Last status: {lastStatus}.");
        }

        return ActionOutcome.Succeeded(
            $"'{host}'{addressNote} answered {replies.Count} of {AttemptCount} pings. " +
            $"Round trip min {replies.Min()} ms, average {replies.Average():F0} ms, " +
            $"max {replies.Max()} ms.");
    }
}

/// <summary>
/// Traces the network path from this cabinet to a named host.
/// </summary>
/// <remarks>
/// Built from <see cref="Ping"/> with an increasing TTL rather than by running
/// <c>tracert</c>, for the same reason as every other probe here.
/// </remarks>
public sealed class TraceRouteExecutor : IActionExecutor
{
    private const int MaximumHops = 20;
    private const int TimeoutMilliseconds = 2000;

    private readonly ILogger<TraceRouteExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="logger">Diagnostic log.</param>
    public TraceRouteExecutor(ILogger<TraceRouteExecutor> logger) => _logger = logger;

    /// <inheritdoc />
    public ActionName Action => ActionName.TraceRoute;

    /// <inheritdoc />
    public async Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, new[] { ActionParameterKeys.TargetHost }, out string unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        if (!HostTarget.TryRead(request, out string host, out string failure))
        {
            return ActionOutcome.Denied(failure);
        }

        using var ping = new Ping();
        var trace = new StringBuilder();
        var reached = false;

        for (var ttl = 1; ttl <= MaximumHops && !reached; ttl++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var options = new PingOptions(ttl, dontFragment: true);

            try
            {
                PingReply reply = await ping
                    .SendPingAsync(host, TimeoutMilliseconds, new byte[32], options)
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);

                trace.Append(CultureInfo.InvariantCulture, $"{ttl}\t");

                switch (reply.Status)
                {
                    case IPStatus.Success:
                        trace.Append(CultureInfo.InvariantCulture,
                            $"{reply.Address} {reply.RoundtripTime} ms (destination)\n");
                        reached = true;
                        break;

                    case IPStatus.TtlExpired:
                        trace.Append(CultureInfo.InvariantCulture,
                            $"{reply.Address} {reply.RoundtripTime} ms\n");
                        break;

                    case IPStatus.TimedOut:
                        // A hop that does not answer is normal and is recorded
                        // as such rather than ending the trace.
                        trace.Append("* (no reply)\n");
                        break;

                    default:
                        trace.Append(CultureInfo.InvariantCulture, $"{reply.Status}\n");
                        break;
                }
            }
            catch (PingException e)
            {
                _logger.LogDebug(e, "Hop {Ttl} of the trace to {Host} failed.", ttl, host);

                if (ttl == 1)
                {
                    // Failing on the first hop means the name did not resolve
                    // at all, which is an answer rather than a partial trace.
                    return ActionOutcome.Failed(
                        $"The path to '{host}' could not be traced: " +
                        $"{e.InnerException?.Message ?? e.Message}.");
                }

                trace.Append(CultureInfo.InvariantCulture, $"{ttl}\t(error)\n");
            }
        }

        string output = trace.ToString();

        return reached
            ? ActionOutcome.Succeeded($"Path to '{host}':\n{output}")
            : ActionOutcome.Failed(
                $"'{host}' was not reached within {MaximumHops} hops. Path so far:\n{output}");
    }
}

/// <summary>
/// Opens a TCP connection from this cabinet to a host and port.
/// </summary>
/// <remarks>
/// The question this answers is the one a ping cannot: whether a host is up but
/// the port is blocked. The port comes from the server's allow-list of ports
/// the CUBEX stack uses, re-checked here — an unconstrained port parameter is a
/// port scanner with extra steps.
/// </remarks>
public sealed class TestPortConnectivityExecutor : IActionExecutor
{
    private const int TimeoutMilliseconds = 5000;

    private readonly ILogger<TestPortConnectivityExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="logger">Diagnostic log.</param>
    public TestPortConnectivityExecutor(ILogger<TestPortConnectivityExecutor> logger) => _logger = logger;

    /// <inheritdoc />
    public ActionName Action => ActionName.TestPortConnectivity;

    /// <inheritdoc />
    public async Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request,
                new[] { ActionParameterKeys.TargetHost, ActionParameterKeys.Port },
                out string unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        if (!HostTarget.TryRead(request, out string host, out string failure))
        {
            return ActionOutcome.Denied(failure);
        }

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.Port, out string rawPort, out string portMissing))
        {
            return ActionOutcome.Denied(portMissing);
        }

        if (!int.TryParse(rawPort, NumberStyles.Integer, CultureInfo.InvariantCulture, out int port))
        {
            return ActionOutcome.Denied($"'{rawPort}' is not a port number.");
        }

        // The agent's own copy of the list. The server checked it too; this is
        // what stops a compromised or simply buggy server reaching a port
        // outside it.
        if (!AgentCubexPorts.Allowed.Contains(port))
        {
            return ActionOutcome.Denied(
                $"Port {port} is not one this agent will open a connection to.");
        }

        using var client = new TcpClient();
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(TimeoutMilliseconds);

        try
        {
            await client.ConnectAsync(host, port, timeoutSource.Token).ConfigureAwait(false);

            return ActionOutcome.Succeeded(
                $"A TCP connection to '{host}' port {port} succeeded. The host is up and the port " +
                "is open from this cabinet.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            // A timeout and a refusal mean different things: a timeout is
            // usually a firewall dropping the packet, a refusal means the host
            // answered and nothing is listening. Reported separately, because
            // they lead to different next steps.
            return ActionOutcome.Failed(
                $"A TCP connection to '{host}' port {port} timed out after " +
                $"{TimeoutMilliseconds / 1000} seconds. Something is dropping the connection rather " +
                "than refusing it, which usually means a firewall.");
        }
        catch (SocketException e)
        {
            _logger.LogDebug(e, "The connection to {Host}:{Port} failed.", host, port);

            return ActionOutcome.Failed(
                $"A TCP connection to '{host}' port {port} failed: {e.SocketErrorCode}. " +
                (e.SocketErrorCode == SocketError.ConnectionRefused
                    ? "The host answered and refused the connection, so it is up but nothing is " +
                      "listening on that port."
                    : e.Message));
        }
    }
}
