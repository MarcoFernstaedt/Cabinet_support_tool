using System.Globalization;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Actions;

namespace CabinetPlatform.Server.Services;

/// <summary>
/// Checks a requested action's parameters against its catalogue entry.
///
/// Two rules, both absolute. An unrecognised key is a rejection, never a
/// silently dropped field. And a recognised key whose value is not of the
/// shape the action expects is also a rejection — an allow-listed key holding
/// a free-form string would just be arbitrary execution with extra steps.
/// </summary>
public interface IActionParameterValidator
{
    /// <summary>Validates and normalises one request's parameters.</summary>
    /// <param name="entry">The catalog entry the request names.</param>
    /// <param name="supplied">What the caller sent.</param>
    /// <param name="nowUtc">The current instant.</param>
    /// <param name="cabinet">The cabinet the action will run on, for zone-aware checks.</param>
    /// <param name="clock">Resolves the cabinet's own time zone.</param>
    OperationResult<IReadOnlyDictionary<string, string>> Validate(
        ActionCatalogEntry entry,
        IReadOnlyDictionary<string, string>? supplied,
        DateTimeOffset nowUtc,
        Cabinet? cabinet = null,
        ICabinetClock? clock = null);
}

public sealed class ActionParameterValidator : IActionParameterValidator
{
    private const int MaxValueLength = 256;

    private readonly IServiceAllowList _serviceAllowList;

    public ActionParameterValidator(IServiceAllowList serviceAllowList) =>
        _serviceAllowList = serviceAllowList;

    /// <inheritdoc />
    public OperationResult<IReadOnlyDictionary<string, string>> Validate(
        ActionCatalogEntry entry,
        IReadOnlyDictionary<string, string>? supplied,
        DateTimeOffset nowUtc,
        Cabinet? cabinet = null,
        ICabinetClock? clock = null)
    {
        var normalised = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        if (supplied is not null)
        {
            foreach ((string key, string value) in supplied)
            {
                if (string.IsNullOrWhiteSpace(key))
                {
                    return OperationResult<IReadOnlyDictionary<string, string>>
                        .Invalid("A parameter key was empty.");
                }

                string trimmedKey = key.Trim();

                if (!entry.AllowedParameterKeys.Contains(trimmedKey))
                {
                    return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                        $"Parameter '{trimmedKey}' is not accepted by {entry.Action}.");
                }

                if (normalised.ContainsKey(trimmedKey))
                {
                    return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                        $"Parameter '{trimmedKey}' was supplied more than once.");
                }

                string trimmedValue = value?.Trim() ?? string.Empty;

                if (trimmedValue.Length > MaxValueLength)
                {
                    return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                        $"Parameter '{trimmedKey}' is too long.");
                }

                normalised[trimmedKey] = trimmedValue;
            }
        }

        // Per-action value rules. Every accepted key is checked here; a key
        // that reaches an agent has had its value proved, not merely its name.
        return entry.Action switch
        {
            ActionName.RestartService or
            ActionName.StartService or
            ActionName.StopService => ValidateServiceName(normalised),

            ActionName.CollectDiagnosticBundle => ValidateDiagnosticBundle(normalised),
            ActionName.ScheduleUpdates => ValidateScheduleUpdates(normalised, nowUtc, cabinet, clock),
            ActionName.RebootMachine => ValidateReboot(normalised),
            ActionName.CollectEventLogs => ValidateEventLogs(normalised),
            ActionName.CollectProcessList => ValidateProcessList(normalised),

            ActionName.PingCabinet or
            ActionName.TraceRouteToCabinet => ValidateCabinetTarget(entry, normalised),

            ActionName.TestCabinetPort => ValidateCabinetPort(entry, normalised),

            _ => OperationResult<IReadOnlyDictionary<string, string>>.Ok(normalised)
        };
    }

    private OperationResult<IReadOnlyDictionary<string, string>> ValidateServiceName(
        Dictionary<string, string> p)
    {
        if (!p.TryGetValue("serviceName", out string? serviceName) ||
            string.IsNullOrWhiteSpace(serviceName))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'serviceName' is required.");
        }

        if (!_serviceAllowList.IsAllowed(serviceName))
        {
            // Not sanitised and forwarded: refused. A name off the list is not
            // a name this product operates on, however it is spelled.
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Service '{serviceName}' is not on the server-side service allow-list.");
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateDiagnosticBundle(
        Dictionary<string, string> p)
    {
        if (p.TryGetValue("includeEventLogs", out string? include) &&
            !bool.TryParse(include, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'includeEventLogs' must be true or false.");
        }

        if (p.TryGetValue("hoursOfHistory", out string? hours))
        {
            if (!int.TryParse(hours, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ||
                value is < 1 or > 168)
            {
                return OperationResult<IReadOnlyDictionary<string, string>>
                    .Invalid("Parameter 'hoursOfHistory' must be between 1 and 168.");
            }
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    /// <summary>
    /// Checks a scheduled install time.
    /// </summary>
    /// <remarks>
    /// The console sends UTC, having converted from the time the rep typed in
    /// the cabinet's local zone. It is re-checked here against that same zone:
    /// a schedule set before a daylight-saving transition and executed after it
    /// must still land at the local hour the rep chose, and an instant that
    /// falls in a skipped hour is refused rather than quietly moved.
    /// </remarks>
    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateScheduleUpdates(
        Dictionary<string, string> p,
        DateTimeOffset nowUtc,
        Cabinet? cabinet,
        ICabinetClock? clock)
    {
        if (!p.TryGetValue("scheduledForUtc", out string? scheduled) ||
            string.IsNullOrWhiteSpace(scheduled))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'scheduledForUtc' is required.");
        }

        if (!DateTimeOffset.TryParse(
                scheduled,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                out DateTimeOffset parsed))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'scheduledForUtc' must be an ISO-8601 UTC timestamp.");
        }

        if (parsed <= nowUtc)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'scheduledForUtc' must be in the future.");
        }

        if (cabinet is not null && clock is not null)
        {
            TimeZoneInfo? zone = clock.ResolveZone(cabinet);

            if (zone is null)
            {
                return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                    "This cabinet has not reported a time zone this server can resolve, so an install " +
                    "cannot be scheduled against its local clock.");
            }

            // The instant is fixed; what has to survive the transition is which
            // local hour it lands on. Converting it back through the cabinet's
            // zone is how that is checked rather than assumed.
            DateTimeOffset local = TimeZoneInfo.ConvertTime(parsed, zone);

            if (zone.IsInvalidTime(local.DateTime))
            {
                return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                    "That local time does not exist at this cabinet: it falls in the hour skipped by a " +
                    "daylight-saving transition.");
            }
        }

        // Re-normalised to round-trip format so the agent never has to guess
        // at the caller's locale.
        p["scheduledForUtc"] = parsed.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

        if (p.TryGetValue("rebootIfRequired", out string? reboot) && !bool.TryParse(reboot, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'rebootIfRequired' must be true or false.");
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateReboot(
        Dictionary<string, string> p)
    {
        if (p.TryGetValue("delaySeconds", out string? delay))
        {
            if (!int.TryParse(delay, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ||
                value is < 0 or > 3600)
            {
                return OperationResult<IReadOnlyDictionary<string, string>>
                    .Invalid("Parameter 'delaySeconds' must be between 0 and 3600.");
            }
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateEventLogs(
        Dictionary<string, string> p)
    {
        if (p.TryGetValue("logName", out string? logName) &&
            !Enum.TryParse<Contracts.Telemetry.EventLogName>(logName, ignoreCase: true, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "Parameter 'logName' must be Application, System or Security.");
        }

        if (p.TryGetValue("minimumLevel", out string? level) &&
            !Enum.TryParse<Contracts.Telemetry.EventLogLevel>(level, ignoreCase: true, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "Parameter 'minimumLevel' is not a known event log level.");
        }

        if (p.TryGetValue("hoursOfHistory", out string? hours) &&
            (!int.TryParse(hours, NumberStyles.Integer, CultureInfo.InvariantCulture, out int window) ||
             window is < 1 or > 168))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'hoursOfHistory' must be between 1 and 168.");
        }

        return ValidateMaxEntries(p, 5000);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateProcessList(
        Dictionary<string, string> p) => ValidateMaxEntries(p, 2000);

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateMaxEntries(
        Dictionary<string, string> p, int ceiling)
    {
        if (p.TryGetValue("maxEntries", out string? max) &&
            (!int.TryParse(max, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ||
             value < 1 || value > ceiling))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter 'maxEntries' must be between 1 and {ceiling}.");
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    /// <summary>
    /// Checks that a probe names a cabinet and nothing else.
    /// </summary>
    /// <remarks>
    /// There is deliberately no host or address parameter. A rep selects a
    /// cabinet; the server resolves what to probe. A request that arrives
    /// already carrying a resolved address is refused, because that address
    /// would be the caller's choice rather than the server's.
    /// </remarks>
    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateCabinetTarget(
        ActionCatalogEntry entry, Dictionary<string, string> p)
    {
        if (p.ContainsKey(ActionCatalog.ResolvedTargetAddressKey))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionCatalog.ResolvedTargetAddressKey}' is set by the server and may not be supplied.");
        }

        if (!p.TryGetValue(ActionCatalog.TargetCabinetIdKey, out string? rawTarget) ||
            !Guid.TryParse(rawTarget, out Guid targetId) ||
            targetId == Guid.Empty)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionCatalog.TargetCabinetIdKey}' must be the id of the cabinet to probe.");
        }

        p[ActionCatalog.TargetCabinetIdKey] = targetId.ToString();

        if (p.TryGetValue(ActionCatalog.AllowCrossSiteKey, out string? cross) && !bool.TryParse(cross, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionCatalog.AllowCrossSiteKey}' must be true or false.");
        }

        _ = entry;
        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateCabinetPort(
        ActionCatalogEntry entry, Dictionary<string, string> p)
    {
        OperationResult<IReadOnlyDictionary<string, string>> target = ValidateCabinetTarget(entry, p);

        if (!target.Succeeded)
        {
            return target;
        }

        if (!p.TryGetValue(ActionCatalog.PortKey, out string? rawPort) ||
            !int.TryParse(rawPort, NumberStyles.Integer, CultureInfo.InvariantCulture, out int port))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionCatalog.PortKey}' is required and must be a number.");
        }

        if (!entry.AllowedPorts.Contains(port))
        {
            // An unconstrained port parameter is a port scanner with extra
            // steps. The list is the server's and holds only the ports the
            // CUBEX stack actually uses.
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Port {port} is not on the server-side CUBEX port allow-list.");
        }

        p[ActionCatalog.PortKey] = port.ToString(CultureInfo.InvariantCulture);
        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }
}
