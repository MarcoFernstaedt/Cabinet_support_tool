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
        if (!p.TryGetValue(ActionParameterKeys.ServiceName, out string? serviceName) ||
            string.IsNullOrWhiteSpace(serviceName))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{ActionParameterKeys.ServiceName}' is required.");
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
        if (p.TryGetValue(ActionParameterKeys.IncludeEventLogs, out string? include) &&
            !bool.TryParse(include, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{ActionParameterKeys.IncludeEventLogs}' must be true or false.");
        }

        if (p.TryGetValue(ActionParameterKeys.HoursOfHistory, out string? hours))
        {
            if (!int.TryParse(hours, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ||
                value is < 1 or > 168)
            {
                return OperationResult<IReadOnlyDictionary<string, string>>
                    .Invalid($"Parameter '{ActionParameterKeys.HoursOfHistory}' must be between 1 and 168.");
            }
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    /// <summary>
    /// Converts a scheduled install time from the cabinet's local clock to UTC,
    /// and refuses a local time that clock does not actually have.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The rep specifies local time because that is what they agreed with the
    /// clinic: "Tuesday at 2am" means 2am at the cabinet, in a fleet spanning
    /// thirteen countries. The conversion happens here rather than in the
    /// console so that one implementation is authoritative and testable.
    /// </para>
    /// <para>
    /// It is also the only place the daylight-saving check can work. Converting
    /// an instant that already arrived as UTC can never produce an invalid
    /// local time — every UTC instant maps to exactly one valid local one — so
    /// a request phrased in UTC has already lost the evidence that the rep
    /// asked for an hour the zone skips. Phrased in local time, it is
    /// detectable, and it is refused rather than quietly slid an hour later.
    /// </para>
    /// </remarks>
    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateScheduleUpdates(
        Dictionary<string, string> p,
        DateTimeOffset nowUtc,
        Cabinet? cabinet,
        ICabinetClock? clock)
    {
        if (p.ContainsKey(ActionParameterKeys.ScheduledForUtc))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.ScheduledForUtc}' is derived by the server from " +
                $"'{ActionParameterKeys.ScheduledForLocal}' and may not be supplied.");
        }

        if (!p.TryGetValue(ActionParameterKeys.ScheduledForLocal, out string? scheduled) ||
            string.IsNullOrWhiteSpace(scheduled))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.ScheduledForLocal}' is required, in the cabinet's " +
                "own local time.");
        }

        // Parsed as an unspecified wall-clock time, deliberately. An offset
        // here would be the caller asserting which side of a transition they
        // meant, which is exactly the judgement this method exists to make.
        if (!DateTime.TryParse(
                scheduled,
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out DateTime local) ||
            local.Kind is not DateTimeKind.Unspecified)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.ScheduledForLocal}' must be a local date and time " +
                "with no time zone offset, for example 2026-03-08T02:30:00.");
        }

        if (cabinet is null || clock is null)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "An install cannot be scheduled without the cabinet whose clock it is scheduled " +
                "against.");
        }

        TimeZoneInfo? zone = clock.ResolveZone(cabinet);

        if (zone is null)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "This cabinet has not reported a time zone this server can resolve, so an install " +
                "cannot be scheduled against its local clock.");
        }

        if (zone.IsInvalidTime(local))
        {
            // The morning a zone springs forward, an hour simply does not
            // happen. Sliding the install into the next real hour would put an
            // update on a cabinet an hour later than the rep agreed with the
            // clinic, and nothing would say so.
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"{local:yyyy-MM-dd HH:mm} does not exist at this cabinet: the clock skips that hour " +
                "for a daylight-saving transition. Choose a time before or after it.");
        }

        // An ambiguous local time happens twice on the morning a zone falls
        // back. The earlier of the two is taken, which is the one a person
        // reading a clock means, and the choice is recorded on the request
        // rather than left for somebody to deduce later.
        TimeSpan offset = zone.IsAmbiguousTime(local)
            ? zone.GetAmbiguousTimeOffsets(local).Max()
            : zone.GetUtcOffset(local);

        var scheduledUtc = new DateTimeOffset(local, offset).ToUniversalTime();

        if (scheduledUtc <= nowUtc)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"{local:yyyy-MM-dd HH:mm} at this cabinet has already passed.");
        }

        // Round-trip format, so the agent never has to guess at a locale.
        p[ActionParameterKeys.ScheduledForLocal] =
            local.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
        p[ActionParameterKeys.ScheduledForUtc] =
            scheduledUtc.ToString("O", CultureInfo.InvariantCulture);

        if (p.TryGetValue(ActionParameterKeys.RebootIfRequired, out string? reboot) &&
            !bool.TryParse(reboot, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.RebootIfRequired}' must be true or false.");
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateReboot(
        Dictionary<string, string> p)
    {
        if (p.TryGetValue(ActionParameterKeys.DelaySeconds, out string? delay))
        {
            if (!int.TryParse(delay, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ||
                value is < 0 or > 3600)
            {
                return OperationResult<IReadOnlyDictionary<string, string>>
                    .Invalid($"Parameter '{ActionParameterKeys.DelaySeconds}' must be between 0 and 3600.");
            }
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateEventLogs(
        Dictionary<string, string> p)
    {
        if (p.TryGetValue(ActionParameterKeys.LogName, out string? logName) &&
            !Enum.TryParse<Contracts.Telemetry.EventLogName>(logName, ignoreCase: true, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.LogName}' must be Application, System or Security.");
        }

        if (p.TryGetValue(ActionParameterKeys.MinimumLevel, out string? level) &&
            !Enum.TryParse<Contracts.Telemetry.EventLogLevel>(level, ignoreCase: true, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.MinimumLevel}' is not a known event log level.");
        }

        if (p.TryGetValue(ActionParameterKeys.HoursOfHistory, out string? hours) &&
            (!int.TryParse(hours, NumberStyles.Integer, CultureInfo.InvariantCulture, out int window) ||
             window is < 1 or > 168))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{ActionParameterKeys.HoursOfHistory}' must be between 1 and 168.");
        }

        return ValidateMaxEntries(p, 5000);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateProcessList(
        Dictionary<string, string> p) => ValidateMaxEntries(p, 2000);

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateMaxEntries(
        Dictionary<string, string> p, int ceiling)
    {
        if (p.TryGetValue(ActionParameterKeys.MaxEntries, out string? max) &&
            (!int.TryParse(max, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ||
             value < 1 || value > ceiling))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.MaxEntries}' must be between 1 and {ceiling}.");
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
