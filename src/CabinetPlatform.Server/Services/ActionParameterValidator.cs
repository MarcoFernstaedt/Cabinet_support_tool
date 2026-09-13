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
    private readonly IProcessAllowList _processAllowList;

    /// <summary>Creates the validator.</summary>
    /// <param name="serviceAllowList">Which services may be acted on.</param>
    /// <param name="processAllowList">Which processes and applications may be acted on.</param>
    public ActionParameterValidator(
        IServiceAllowList serviceAllowList, IProcessAllowList processAllowList)
    {
        _serviceAllowList = serviceAllowList;
        _processAllowList = processAllowList;
    }

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

                // Selected-process operands are observations, not text to repair.
                // Keep their exact values; in particular never trim an image path.
                bool selectedProcess = entry.Action == ActionName.KillProcess;
                string trimmedValue = selectedProcess ? value ?? string.Empty : value?.Trim() ?? string.Empty;
                int maxLength = selectedProcess && string.Equals(trimmedKey,
                    ActionParameterKeys.ExpectedExecutablePath, StringComparison.OrdinalIgnoreCase) ? 32767 : MaxValueLength;

                if (trimmedValue.Length > maxLength)
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

            ActionName.SetServiceStartType => ValidateServiceStartType(normalised),

            ActionName.CollectDiagnosticBundle => ValidateDiagnosticBundle(normalised),
            ActionName.ScheduleUpdates => ValidateScheduleUpdates(normalised, nowUtc, cabinet, clock),
            ActionName.InstallUpdatesNow => ValidateInstallUpdatesNow(normalised),
            ActionName.RebootMachine => ValidateReboot(normalised),
            ActionName.CollectEventLogs => ValidateEventLogs(normalised),
            ActionName.RunEventLogView => ValidateEventLogView(normalised),
            ActionName.GetProcessList => ValidateProcessList(normalised),

            ActionName.KillProcess => ValidateKillProcess(normalised),
            ActionName.KillProcessByName => ValidateProcessName(normalised),
            ActionName.RestartApplication => ValidateApplicationName(normalised),

            ActionName.PingCabinet or
            ActionName.TraceRouteToCabinet => ValidateCabinetTarget(entry, normalised),

            ActionName.TestCabinetPort => ValidateCabinetPort(entry, normalised),

            ActionName.PingHost or
            ActionName.TraceRoute => ValidateHostTarget(normalised),

            ActionName.TestPortConnectivity => ValidateHostPort(entry, normalised),

            ActionName.SetDnsServers => ValidateDnsServers(normalised),
            ActionName.SetStaticIpAddress => ValidateStaticIp(normalised),
            ActionName.SetAdapterToDhcp => ValidateAdapterOnly(normalised),

            // The reserved actuation actions accept no parameters at all, and
            // are refused before dispatch regardless. Falling through here is
            // therefore correct and not an omission: an empty allow-list has
            // already rejected anything a caller sent.
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

    /// <summary>
    /// Checks a kill by process id.
    /// </summary>
    /// <remarks>
    /// Require all four observed operands without rounding or repairing their
    /// values. The agent independently validates them against one retained handle.
    /// This path is for comparison only and does not authorize executable launch.
    /// </remarks>
    private OperationResult<IReadOnlyDictionary<string, string>> ValidateKillProcess(
        Dictionary<string, string> p)
    {
        if (!p.TryGetValue(ActionParameterKeys.ProcessId, out string? rawPid) ||
            !int.TryParse(rawPid, NumberStyles.None, CultureInfo.InvariantCulture, out int pid) ||
            pid <= 0)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.ProcessId}' must be a positive process id.");
        }

        // Process id 4 is the Windows kernel on every version of Windows there
        // is. Nothing else uses it, and nothing good comes of naming it.
        if (pid == 4)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "Process id 4 is the Windows System process and is never a valid target.");
        }

        if (!p.TryGetValue(ActionParameterKeys.ExpectedProcessName, out string? name) ||
            string.IsNullOrWhiteSpace(name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.ExpectedProcessName}' is required alongside " +
                $"'{ActionParameterKeys.ProcessId}'. Process ids are reused, so an id without the " +
                "name it is expected to belong to is not an identification.");
        }

        if (!p.TryGetValue(ActionParameterKeys.ExpectedCreationTimeFileTime, out string? rawCreation) ||
            !long.TryParse(rawCreation, NumberStyles.None, CultureInfo.InvariantCulture, out long creation) || creation <= 0)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "The selected process creation FILETIME must be a positive exact decimal Int64.");
        }
        if (!p.TryGetValue(ActionParameterKeys.ExpectedExecutablePath, out string? path) ||
            !ProcessSelectionIdentity.IsValidExecutablePath(path))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "The selected process requires its observed full Windows image path, at most 32767 characters without control characters.");
        }

        OperationResult<IReadOnlyDictionary<string, string>> permitted =
            CheckProcessName(name, ActionParameterKeys.ExpectedProcessName);

        if (!permitted.Succeeded)
        {
            return permitted;
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private OperationResult<IReadOnlyDictionary<string, string>> ValidateProcessName(
        Dictionary<string, string> p)
    {
        if (!p.TryGetValue(ActionParameterKeys.ProcessName, out string? name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{ActionParameterKeys.ProcessName}' is required.");
        }

        OperationResult<IReadOnlyDictionary<string, string>> permitted =
            CheckProcessName(name, ActionParameterKeys.ProcessName);

        if (!permitted.Succeeded)
        {
            return permitted;
        }

        p[ActionParameterKeys.ProcessName] = CriticalProcessDenyList.Normalise(name);

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    /// <summary>
    /// The deny-list first, then the allow-list.
    /// </summary>
    /// <remarks>
    /// The order is the point, and the two refusals say different things on
    /// purpose. A name on the deny-list is refused with an explanation of what
    /// ending it would do, because a rep who asked for it is about to ask again
    /// a different way unless they understand why not. Ending <c>lsass</c>
    /// bluescreens the machine immediately, which on a cabinet holding
    /// controlled substances means a site visit and an interrupted
    /// chain-of-custody record.
    /// </remarks>
    private OperationResult<IReadOnlyDictionary<string, string>> CheckProcessName(
        string? name, string key)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{key}' is required.");
        }

        if (CriticalProcessDenyList.IsCritical(name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"'{name.Trim()}' is a critical Windows process. Ending it would take the cabinet " +
                "down immediately, in some cases with a bluescreen, and no role or grant permits it.");
        }

        if (!_processAllowList.IsProcessAllowed(name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Process '{name.Trim()}' is not on the server-side process allow-list.");
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase));
    }

    private OperationResult<IReadOnlyDictionary<string, string>> ValidateApplicationName(
        Dictionary<string, string> p)
    {
        if (!p.TryGetValue(ActionParameterKeys.ApplicationName, out string? name) ||
            string.IsNullOrWhiteSpace(name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{ActionParameterKeys.ApplicationName}' is required.");
        }

        if (CriticalProcessDenyList.IsCritical(name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"'{name.Trim()}' is a critical Windows process and is never restarted this way.");
        }

        if (!_processAllowList.IsApplicationAllowed(name))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Application '{name.Trim()}' is not on the server-side application allow-list. " +
                "The executable it would relaunch comes from the agent's own registration for that " +
                "name; there is no path parameter to supply instead.");
        }

        p[ActionParameterKeys.ApplicationName] = CriticalProcessDenyList.Normalise(name);

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private OperationResult<IReadOnlyDictionary<string, string>> ValidateServiceStartType(
        Dictionary<string, string> p)
    {
        OperationResult<IReadOnlyDictionary<string, string>> named = ValidateServiceName(p);

        if (!named.Succeeded)
        {
            return named;
        }

        if (!p.TryGetValue(ActionParameterKeys.StartType, out string? raw) ||
            !Enum.TryParse(raw, ignoreCase: true, out Contracts.Telemetry.ServiceStartType startType))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.StartType}' must be Automatic, AutomaticDelayed, " +
                "Manual or Disabled.");
        }

        // Boot and System start types belong to drivers loaded before the
        // service control manager is running. Setting an ordinary service to
        // one of them does not make it start earlier; it makes the machine fail
        // to boot. Unknown is not a setting at all.
        if (startType is Contracts.Telemetry.ServiceStartType.Boot
            or Contracts.Telemetry.ServiceStartType.System
            or Contracts.Telemetry.ServiceStartType.Unknown)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"'{startType}' is a driver load order, not a service start type support may set. " +
                "Use Automatic, AutomaticDelayed, Manual or Disabled.");
        }

        p[ActionParameterKeys.StartType] = startType.ToString();

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    /// <summary>
    /// Checks the view a run names, and refuses a caller-supplied definition.
    /// </summary>
    /// <remarks>
    /// The definition key is filled in by the server after it has read the view
    /// from the database. A request that arrives already carrying one is
    /// refused outright, because that definition would be the caller's rather
    /// than the Supervisor's — and the reason views are stored server-side at
    /// all is that nobody should be able to hand an agent a filter of their own
    /// devising.
    /// </remarks>
    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateEventLogView(
        Dictionary<string, string> p)
    {
        if (p.ContainsKey(ActionParameterKeys.EventLogViewDefinition))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.EventLogViewDefinition}' is expanded by the server " +
                "from the stored view and may not be supplied.");
        }

        if (!p.TryGetValue(ActionParameterKeys.EventLogViewId, out string? raw) ||
            !Guid.TryParse(raw, out Guid viewId) ||
            viewId == Guid.Empty)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.EventLogViewId}' must be the id of a stored event " +
                "log view.");
        }

        p[ActionParameterKeys.EventLogViewId] = viewId.ToString();

        if (p.TryGetValue(ActionParameterKeys.HoursOfHistory, out string? hours) &&
            (!int.TryParse(hours, NumberStyles.Integer, CultureInfo.InvariantCulture, out int window) ||
             window is < 1 or > 168))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{ActionParameterKeys.HoursOfHistory}' must be between 1 and 168.");
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateInstallUpdatesNow(
        Dictionary<string, string> p)
    {
        OperationResult<IReadOnlyDictionary<string, string>> ids = ValidateUpdateIds(p, required: true);

        if (!ids.Succeeded)
        {
            return ids;
        }

        if (p.TryGetValue(ActionParameterKeys.RebootIfRequired, out string? reboot) &&
            !bool.TryParse(reboot, out _))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.RebootIfRequired}' must be true or false.");
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    /// <summary>
    /// Checks the list of updates an install names.
    /// </summary>
    /// <remarks>
    /// Specific ids, always. "Everything applicable" would install whatever has
    /// become applicable between the rep reading a scan result and the machine
    /// acting on it, which is not what the clinic agreed to and not what the
    /// audit trail would then be describing.
    /// </remarks>
    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateUpdateIds(
        Dictionary<string, string> p, bool required)
    {
        const int MaxUpdates = 50;

        if (!p.TryGetValue(ActionParameterKeys.UpdateIds, out string? raw) ||
            string.IsNullOrWhiteSpace(raw))
        {
            return required
                ? OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                    $"Parameter '{ActionParameterKeys.UpdateIds}' is required: an install names the " +
                    "specific updates a person chose, never everything that happens to be applicable.")
                : OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
        }

        string[] ids = raw
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToArray();

        if (ids.Length == 0)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.UpdateIds}' names no updates.");
        }

        if (ids.Length > MaxUpdates)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.UpdateIds}' names more than {MaxUpdates} updates.");
        }

        foreach (string id in ids)
        {
            // Windows Update identifies an update by a GUID. Parsing it as one
            // rather than accepting text is what keeps this a name and not a
            // string the agent might do something else with.
            if (!Guid.TryParse(id, out _))
            {
                return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                    $"'{id}' is not a Windows Update identifier.");
            }
        }

        p[ActionParameterKeys.UpdateIds] = string.Join(',', ids.Select(id => Guid.Parse(id).ToString()));

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateHostTarget(
        Dictionary<string, string> p)
    {
        if (!DiagnosticHostPolicy.TryNormalise(
                p.GetValueOrDefault(ActionParameterKeys.TargetHost),
                out string host,
                out string failure))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(failure);
        }

        p[ActionParameterKeys.TargetHost] = host;

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateHostPort(
        ActionCatalogEntry entry, Dictionary<string, string> p)
    {
        OperationResult<IReadOnlyDictionary<string, string>> host = ValidateHostTarget(p);

        if (!host.Succeeded)
        {
            return host;
        }

        if (!DiagnosticHostPolicy.TryNormalisePort(
                p.GetValueOrDefault(ActionCatalog.PortKey),
                entry.AllowedPorts,
                out string port,
                out string failure))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(failure);
        }

        p[ActionCatalog.PortKey] = port;

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    /// <summary>
    /// Checks the adapter every network configuration change names.
    /// </summary>
    /// <remarks>
    /// The adapter is named by its stable Windows identifier — the settings id
    /// the agent reports on every check-in — rather than by its friendly name,
    /// which a site administrator can rename at any time and which is not
    /// unique on a machine with two identical cards.
    /// </remarks>
    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateAdapterOnly(
        Dictionary<string, string> p)
    {
        if (!p.TryGetValue(ActionParameterKeys.AdapterId, out string? adapter) ||
            string.IsNullOrWhiteSpace(adapter))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid($"Parameter '{ActionParameterKeys.AdapterId}' is required.");
        }

        if (adapter.Length > 128 || adapter.Any(c => char.IsControl(c) || c is '"' or '\\'))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.AdapterId}' is not a network adapter identifier.");
        }

        p[ActionParameterKeys.AdapterId] = adapter.Trim();

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateDnsServers(
        Dictionary<string, string> p)
    {
        OperationResult<IReadOnlyDictionary<string, string>> adapter = ValidateAdapterOnly(p);

        if (!adapter.Succeeded)
        {
            return adapter;
        }

        if (!p.TryGetValue(ActionParameterKeys.DnsServers, out string? raw) ||
            string.IsNullOrWhiteSpace(raw))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"Parameter '{ActionParameterKeys.DnsServers}' is required, as one or two addresses " +
                "separated by a comma.");
        }

        string[] servers = raw
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToArray();

        if (servers.Length is < 1 or > 3)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                "Between one and three DNS servers may be set.");
        }

        var parsed = new List<string>(servers.Length);

        foreach (string server in servers)
        {
            if (!System.Net.IPAddress.TryParse(server, out System.Net.IPAddress? address))
            {
                return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                    $"'{server}' is not an IP address. A DNS server is set by address, never by name — " +
                    "a name would have to be resolved by the resolver being reconfigured.");
            }

            if (!DiagnosticHostPolicy.IsProbableTarget(address, out string failure))
            {
                return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                    $"'{server}' cannot be a DNS server: {failure}");
            }

            parsed.Add(address.ToString());
        }

        p[ActionParameterKeys.DnsServers] = string.Join(',', parsed);

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateStaticIp(
        Dictionary<string, string> p)
    {
        OperationResult<IReadOnlyDictionary<string, string>> adapter = ValidateAdapterOnly(p);

        if (!adapter.Succeeded)
        {
            return adapter;
        }

        if (!TryReadIpv4(p, ActionParameterKeys.IpAddress, required: true, out string address, out string failure))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(failure);
        }

        if (!System.Net.IPAddress.TryParse(address, out System.Net.IPAddress? parsedAddress))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"'{address}' is not an IPv4 address.");
        }

        if (!DiagnosticHostPolicy.IsProbableTarget(parsedAddress, out string addressFailure))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"'{address}' is not an address a cabinet can be given: {addressFailure}");
        }

        if (!TryReadIpv4(p, ActionParameterKeys.SubnetMask, required: true, out string mask, out failure))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(failure);
        }

        if (!IsContiguousMask(mask))
        {
            // A mask with a hole in it is accepted by nothing and produces a
            // machine that can reach some of its own subnet.
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(
                $"'{mask}' is not a valid subnet mask: the set bits must be contiguous.");
        }

        if (!TryReadIpv4(p, ActionParameterKeys.DefaultGateway, required: false, out string gateway, out failure))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>.Invalid(failure);
        }

        p[ActionParameterKeys.IpAddress] = address;
        p[ActionParameterKeys.SubnetMask] = mask;

        if (!string.IsNullOrEmpty(gateway))
        {
            p[ActionParameterKeys.DefaultGateway] = gateway;
        }

        return OperationResult<IReadOnlyDictionary<string, string>>.Ok(p);
    }

    private static bool TryReadIpv4(
        Dictionary<string, string> p,
        string key,
        bool required,
        out string value,
        out string failureReason)
    {
        value = string.Empty;
        failureReason = string.Empty;

        if (!p.TryGetValue(key, out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            if (!required)
            {
                return true;
            }

            failureReason = $"Parameter '{key}' is required.";
            return false;
        }

        if (!System.Net.IPAddress.TryParse(raw.Trim(), out System.Net.IPAddress? address) ||
            address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
        {
            failureReason = $"Parameter '{key}' must be an IPv4 address.";
            return false;
        }

        value = address.ToString();
        return true;
    }

    private static bool IsContiguousMask(string mask)
    {
        if (!System.Net.IPAddress.TryParse(mask, out System.Net.IPAddress? parsed))
        {
            return false;
        }

        byte[] octets = parsed.GetAddressBytes();
        uint bits = ((uint)octets[0] << 24) | ((uint)octets[1] << 16) | ((uint)octets[2] << 8) | octets[3];

        // A contiguous mask is a run of ones followed by a run of zeroes, so
        // its complement plus one is a power of two. Zero and all-ones are
        // handled by the same arithmetic.
        uint complement = ~bits;

        return (complement & (complement + 1)) == 0;
    }

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
