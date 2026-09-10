using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Configuration;

/// <summary>
/// Fails the host at startup rather than at the first check-in when the agent
/// is misconfigured. A service that starts and then quietly does nothing useful
/// is worse than one that refuses to start and says why.
/// </summary>
public sealed class AgentOptionsValidator : IValidateOptions<AgentOptions>
{
    public ValidateOptionsResult Validate(string? name, AgentOptions options)
    {
        var failures = new List<string>();

        if (!Uri.TryCreate(options.ServerBaseUrl, UriKind.Absolute, out var serverUri))
        {
            failures.Add($"{AgentOptions.SectionName}:ServerBaseUrl must be an absolute URI.");
        }
        else if (serverUri.Scheme != Uri.UriSchemeHttps)
        {
            // Check-ins carry a complete inventory of a controlled-substance
            // cabinet's host. That does not travel in clear text.
            failures.Add($"{AgentOptions.SectionName}:ServerBaseUrl must use https.");
        }

        if (options.CheckInIntervalSeconds < 30 || options.CheckInIntervalSeconds > 86_400)
        {
            failures.Add($"{AgentOptions.SectionName}:CheckInIntervalSeconds must be between 30 and 86400.");
        }

        if (options.CheckInJitterPercent is < 0 or > 50)
        {
            failures.Add($"{AgentOptions.SectionName}:CheckInJitterPercent must be between 0 and 50.");
        }

        if (options.Backoff.MaximumSeconds < options.Backoff.InitialSeconds)
        {
            failures.Add($"{AgentOptions.SectionName}:Backoff:MaximumSeconds must be at least InitialSeconds.");
        }

        failures.AddRange(ValidateAnnotations(options.Buffer, "Buffer"));
        failures.AddRange(ValidateAnnotations(options.Backoff, "Backoff"));
        failures.AddRange(ValidateAnnotations(options.Collection, "Collection"));
        failures.AddRange(ValidateAnnotations(options.Actions, "Actions"));

        foreach (var entry in options.Actions.TimeoutSecondsByAction)
        {
            if (!Enum.TryParse<Contracts.Actions.ActionName>(entry.Key, ignoreCase: false, out _))
            {
                failures.Add(
                    $"{AgentOptions.SectionName}:Actions:TimeoutSecondsByAction contains '{entry.Key}', " +
                    "which is not a member of the ActionName catalog.");
            }

            if (entry.Value is < 1 or > 3600)
            {
                failures.Add(
                    $"{AgentOptions.SectionName}:Actions:TimeoutSecondsByAction:{entry.Key} " +
                    "must be between 1 and 3600 seconds.");
            }
        }

        return failures.Count == 0
            ? ValidateOptionsResult.Success
            : ValidateOptionsResult.Fail(failures);
    }

    private static IEnumerable<string> ValidateAnnotations(object instance, string sectionPath)
    {
        var results = new List<ValidationResult>();
        Validator.TryValidateObject(instance, new ValidationContext(instance), results, validateAllProperties: true);
        return results.Select(r => $"{AgentOptions.SectionName}:{sectionPath}: {r.ErrorMessage}");
    }
}
