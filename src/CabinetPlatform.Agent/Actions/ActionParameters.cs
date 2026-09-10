using System.Globalization;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Actions;

/// <summary>
/// The parameter names the agent understands, and how it reads them.
/// </summary>
/// <remarks>
/// Parameters arrive as strings, which is the one place in the contract where
/// server-supplied text reaches the agent. Every reader here is a narrow
/// parser for a specific expected shape: a service name, a UTC timestamp, a
/// boolean. None of them will ever return something the agent then interprets
/// as an instruction.
/// </remarks>
public static class ActionParameters
{
    /// <summary>Target of the service actions.</summary>
    public const string ServiceName = "ServiceName";

    /// <summary>When <see cref="ActionName.ScheduleUpdates"/> should install.</summary>
    public const string ScheduledUtc = "ScheduledUtc";

    /// <summary>
    /// Set by a supervisor to allow a reboot while somebody is signed in.
    /// </summary>
    public const string SupervisorOverride = "SupervisorOverride";

    /// <summary>Optional note included in a diagnostic bundle.</summary>
    public const string BundleNote = "Note";

    /// <summary>
    /// Reads a required string parameter.
    /// </summary>
    public static bool TryGetRequiredString(
        ActionRequestDto request,
        string name,
        out string value,
        out string failureReason)
    {
        if (!request.Parameters.TryGetValue(name, out var raw) || string.IsNullOrWhiteSpace(raw))
        {
            value = string.Empty;
            failureReason = $"The '{name}' parameter is required and was not supplied.";
            return false;
        }

        value = raw.Trim();
        failureReason = string.Empty;
        return true;
    }

    /// <summary>
    /// Reads an optional boolean flag.
    /// </summary>
    /// <remarks>
    /// Anything that is not an explicit affirmative reads as false. A flag that
    /// waives a safety check is not something to infer from an unparseable
    /// value.
    /// </remarks>
    public static bool GetBooleanFlag(ActionRequestDto request, string name)
    {
        if (!request.Parameters.TryGetValue(name, out var raw) || string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        var value = raw.Trim();

        return value.Equals("true", StringComparison.OrdinalIgnoreCase)
            || value.Equals("yes", StringComparison.OrdinalIgnoreCase)
            || value.Equals("1", StringComparison.Ordinal);
    }

    /// <summary>
    /// Reads a required UTC instant.
    /// </summary>
    /// <remarks>
    /// Round-trip format only, and the result is converted to UTC. A cabinet
    /// in a clinic two time zones from the support desk must not schedule an
    /// update install at what turns out to be the middle of its own working day.
    /// </remarks>
    public static bool TryGetUtcTimestamp(
        ActionRequestDto request,
        string name,
        out DateTimeOffset value,
        out string failureReason)
    {
        value = default;

        if (!TryGetRequiredString(request, name, out var raw, out failureReason))
        {
            return false;
        }

        if (!DateTimeOffset.TryParse(
                raw,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind | DateTimeStyles.AllowWhiteSpaces,
                out var parsed))
        {
            failureReason = $"The '{name}' parameter '{raw}' is not a valid ISO-8601 timestamp.";
            return false;
        }

        value = parsed.ToUniversalTime();
        failureReason = string.Empty;
        return true;
    }

    /// <summary>
    /// Rejects a request carrying parameters this action does not define.
    /// </summary>
    /// <remarks>
    /// An unexpected parameter means the agent and the server disagree about
    /// what was asked for. On a controlled-substance cabinet the safe reading
    /// of that disagreement is to do nothing.
    /// </remarks>
    public static bool TryValidateNoUnknownParameters(
        ActionRequestDto request,
        IReadOnlyCollection<string> permitted,
        out string failureReason)
    {
        var unknown = request.Parameters.Keys
            .Where(key => !permitted.Contains(key, StringComparer.OrdinalIgnoreCase))
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();

        if (unknown.Length == 0)
        {
            failureReason = string.Empty;
            return true;
        }

        failureReason =
            $"The request carries parameters this action does not define: {string.Join(", ", unknown)}.";
        return false;
    }
}
