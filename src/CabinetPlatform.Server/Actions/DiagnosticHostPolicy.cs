using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace CabinetPlatform.Server.Actions;

/// <summary>
/// What a generic network probe is allowed to name as its target.
/// </summary>
/// <remarks>
/// <para>
/// The cabinet-targeted probes take a cabinet id and the server resolves the
/// address, which is by far the safer shape and is what a rep uses for the
/// question they actually have. These generic probes exist for the other case:
/// "can this cabinet reach the practice management server at 10.4.1.20", or
/// "does DNS resolve at all from here". A rep has to be able to name that
/// target, because the platform does not know about it.
/// </para>
/// <para>
/// So the value is constrained rather than trusted. A host name is checked
/// against the shape of a host name; an address is parsed as an address; and
/// the classes of address that answer nothing useful from a cabinet — loopback,
/// link-local, multicast, broadcast, the unspecified address — are refused,
/// both because probing them tells nobody anything and because an unconstrained
/// target parameter is a port scanner with extra steps.
/// </para>
/// </remarks>
public static class DiagnosticHostPolicy
{
    /// <summary>
    /// The shape of a DNS host name: labels of letters, digits and hyphens,
    /// separated by dots, no label leading or trailing with a hyphen.
    /// </summary>
    private static readonly Regex HostName = new(
        @"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>
    /// Checks a target and returns it in its normalised form.
    /// </summary>
    /// <param name="raw">The value the caller supplied.</param>
    /// <param name="normalised">The value to store and dispatch.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public static bool TryNormalise(string? raw, out string normalised, out string failureReason)
    {
        normalised = string.Empty;

        if (string.IsNullOrWhiteSpace(raw))
        {
            failureReason = "A target host is required.";
            return false;
        }

        string candidate = raw.Trim();

        if (candidate.Length > 253)
        {
            failureReason = "The target host is longer than a host name may be.";
            return false;
        }

        if (IPAddress.TryParse(candidate, out IPAddress? address))
        {
            if (!IsProbableTarget(address, out failureReason))
            {
                return false;
            }

            normalised = address.ToString();
            failureReason = string.Empty;
            return true;
        }

        if (!HostName.IsMatch(candidate))
        {
            // Refused rather than escaped or stripped. A value that is not a
            // host name is not a host name however it is cleaned up, and the
            // agent resolves this string itself.
            failureReason =
                "The target host is neither an IP address nor a well-formed host name.";
            return false;
        }

        if (candidate.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        {
            failureReason =
                "Probing localhost from a cabinet answers a question nobody asked. " +
                "Name the host the cabinet is failing to reach.";
            return false;
        }

        normalised = candidate.ToLowerInvariant();
        failureReason = string.Empty;
        return true;
    }

    /// <summary>
    /// Whether an address is one a cabinet could usefully probe.
    /// </summary>
    /// <param name="address">The parsed address.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public static bool IsProbableTarget(IPAddress address, out string failureReason)
    {
        if (IPAddress.IsLoopback(address))
        {
            failureReason =
                "A loopback address names the cabinet itself, which tells nobody whether it can " +
                "reach anything.";
            return false;
        }

        if (address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any))
        {
            failureReason = "The unspecified address does not name a host.";
            return false;
        }

        if (address.Equals(IPAddress.Broadcast))
        {
            failureReason = "The broadcast address does not name a host.";
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

            // 224.0.0.0/4 is multicast; 169.254.0.0/16 is the address a machine
            // gives itself when DHCP failed, which is a symptom rather than a
            // destination.
            if (octets[0] >= 224)
            {
                failureReason = "Multicast and reserved addresses do not name a host worth probing.";
                return false;
            }

            if (octets[0] == 169 && octets[1] == 254)
            {
                failureReason =
                    "A link-local address is what a machine assigns itself when DHCP fails. " +
                    "It is not reachable from anywhere else.";
                return false;
            }
        }

        failureReason = string.Empty;
        return true;
    }

    /// <summary>
    /// Checks a port against the CUBEX allow-list and returns it normalised.
    /// </summary>
    /// <param name="raw">The value the caller supplied.</param>
    /// <param name="allowed">The ports this action may probe.</param>
    /// <param name="normalised">The value to store and dispatch.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public static bool TryNormalisePort(
        string? raw,
        IReadOnlySet<int> allowed,
        out string normalised,
        out string failureReason)
    {
        normalised = string.Empty;

        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int port))
        {
            failureReason = "A port is required and must be a number.";
            return false;
        }

        if (!allowed.Contains(port))
        {
            failureReason =
                $"Port {port} is not on the server-side CUBEX port allow-list. " +
                "An unconstrained port parameter is a port scanner with extra steps.";
            return false;
        }

        normalised = port.ToString(CultureInfo.InvariantCulture);
        failureReason = string.Empty;
        return true;
    }
}
