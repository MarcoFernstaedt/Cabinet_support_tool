using System.Globalization;
using CabinetPlatform.Contracts.Enums;
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
    OperationResult<IReadOnlyDictionary<string, string>> Validate(
        ActionCatalogEntry entry,
        IDictionary<string, string>? supplied);
}

public sealed class ActionParameterValidator : IActionParameterValidator
{
    private const int MaxValueLength = 256;

    private readonly IServiceAllowList _serviceAllowList;

    public ActionParameterValidator(IServiceAllowList serviceAllowList) =>
        _serviceAllowList = serviceAllowList;

    public OperationResult<IReadOnlyDictionary<string, string>> Validate(
        ActionCatalogEntry entry,
        IDictionary<string, string>? supplied)
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
            CabinetActionType.RestartService or
            CabinetActionType.StartService or
            CabinetActionType.StopService => ValidateServiceName(normalised),

            CabinetActionType.CollectDiagnosticBundle => ValidateDiagnosticBundle(normalised),
            CabinetActionType.ScheduleUpdates => ValidateScheduleUpdates(normalised),
            CabinetActionType.RebootMachine => ValidateReboot(normalised),

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

    private static OperationResult<IReadOnlyDictionary<string, string>> ValidateScheduleUpdates(
        Dictionary<string, string> p)
    {
        if (!p.TryGetValue("scheduledForUtc", out string? scheduled) ||
            string.IsNullOrWhiteSpace(scheduled))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'scheduledForUtc' is required.");
        }

        if (!DateTime.TryParse(
                scheduled,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                out DateTime parsed))
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'scheduledForUtc' must be an ISO-8601 UTC timestamp.");
        }

        if (parsed <= DateTime.UtcNow)
        {
            return OperationResult<IReadOnlyDictionary<string, string>>
                .Invalid("Parameter 'scheduledForUtc' must be in the future.");
        }

        // Re-normalised to round-trip format so the agent never has to guess
        // at the caller's locale.
        p["scheduledForUtc"] = parsed.ToString("O", CultureInfo.InvariantCulture);

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
}
