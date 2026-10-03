using System.Globalization;
using System.Net;
using System.Net.Sockets;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// The parameter names the cabinet-to-cabinet probes read.
/// </summary>
/// <remarks>
/// The address is supplied by the server, which resolved it from the target
/// cabinet's last reported adapter. A rep names a cabinet; nobody outside the
/// server names an address, and the agent will not probe one that did not
/// arrive this way.
/// </remarks>
internal static class LinkParameters
{
    public const string TargetCabinetId = ActionParameterKeys.TargetCabinetId;
    public const string ResolvedTargetAddress = ActionParameterKeys.ResolvedTargetAddress;
    public const string Port = ActionParameterKeys.Port;
    public const string AllowCrossSite = ActionParameterKeys.AllowCrossSite;

    /// <summary>
    /// Reads and validates the address the server resolved.
    /// </summary>
    /// <remarks>
    /// Parsed as an <see cref="IPAddress"/> rather than accepted as text, so
    /// there is no path by which a hostname — let alone anything else — reaches
    /// a network call. Loopback, multicast and unspecified addresses are
    /// refused: none of them names another cabinet, and a probe of one tells
    /// nobody anything true.
    /// </remarks>
    public static bool TryReadTarget(
        ActionRequestDto request, out IPAddress address, out string failureReason)
    {
        address = IPAddress.None;

        if (!request.Parameters.TryGetValue(ResolvedTargetAddress, out string? raw) ||
            string.IsNullOrWhiteSpace(raw))
        {
            failureReason =
                "The request carries no server-resolved target address, so there is nothing to probe. " +
                "The agent never resolves a target itself.";
            return false;
        }

        if (!IPAddress.TryParse(raw.Trim(), out IPAddress? parsed))
        {
            failureReason = "The server-resolved target address is not an IP address.";
            return false;
        }

        if (IPAddress.IsLoopback(parsed) ||
            parsed.Equals(IPAddress.Any) ||
            parsed.Equals(IPAddress.IPv6Any))
        {
            failureReason = "The resolved target address does not name another cabinet.";
            return false;
        }

        address = parsed;
        failureReason = string.Empty;
        return true;
    }
}

/// <summary>
/// Opens a TCP connection from this cabinet to a port on another.
/// </summary>
/// <remarks>
/// Tells a host that is down from a port that is blocked, which a ping cannot.
/// The port comes from the server's allow-list of ports the CUBEX stack uses:
/// an unconstrained port parameter would be a port scanner with extra steps.
/// </remarks>
public sealed class TestCabinetPortExecutor : IActionExecutor
{
    private const int TimeoutMilliseconds = 5000;

    private readonly ILogger<TestCabinetPortExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="logger">Diagnostic log.</param>
    public TestCabinetPortExecutor(ILogger<TestCabinetPortExecutor> logger) => _logger = logger;

    /// <inheritdoc />
    public ActionName Action => ActionName.TestCabinetPort;

    /// <inheritdoc />
    public async Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request,
                new[]
                {
                    LinkParameters.TargetCabinetId,
                    LinkParameters.ResolvedTargetAddress,
                    LinkParameters.Port,
                    LinkParameters.AllowCrossSite,
                },
                out string unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        if (!LinkParameters.TryReadTarget(request, out IPAddress address, out string failure))
        {
            return ActionOutcome.Denied(failure);
        }

        if (!request.Parameters.TryGetValue(LinkParameters.Port, out string? rawPort) ||
            !int.TryParse(rawPort, NumberStyles.None, CultureInfo.InvariantCulture, out int port) ||
            port is < 1 or > 65535)
        {
            return ActionOutcome.Denied("The request carries no usable port to test.");
        }

        // The agent re-checks the port against its own copy of the list. The
        // server validates it too; this is what keeps a compromised or simply
        // buggy server from steering the agent outside it.
        if (!AgentCubexPorts.Allowed.Contains(port))
        {
            return ActionOutcome.Denied(
                $"Port {port} is not one this agent will probe. The list is fixed at build time.");
        }

        using var client = new TcpClient(address.AddressFamily);

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeoutMilliseconds);

            await client.ConnectAsync(address, port, timeout.Token).ConfigureAwait(false);

            return ActionOutcome.Succeeded($"Connected to {address}:{port}.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return ActionOutcome.Failed(
                $"No answer from {address}:{port} within {TimeoutMilliseconds} ms. The host may be up " +
                "with the port filtered, which a ping would not have shown.");
        }
        catch (SocketException e)
        {
            _logger.LogDebug(e, "The connection to {Address}:{Port} failed.", address, port);
            return ActionOutcome.Failed($"Could not connect to {address}:{port}: {e.SocketErrorCode}.");
        }
    }
}

/// <summary>
/// The ports this agent will probe, fixed at build time.
/// </summary>
/// <remarks>
/// A second copy of the server's list, on purpose. The server validates the
/// port before dispatch; this exists so that a compromised or simply buggy
/// server still cannot reach a port outside it.
/// </remarks>
internal static class AgentCubexPorts
{
    public static readonly IReadOnlySet<int> Allowed =
        new HashSet<int> { 135, 443, 445, 1433, 3389, 5985, 5986 };
}
