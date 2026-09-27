using System.Text.Json;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Runs one server-defined event log view and returns what matched.
/// </summary>
/// <remarks>
/// <para>
/// The agent receives a view's fields — logs, sources, event ids, a level and a
/// window — and builds its own query from them. It never receives an XPath, and
/// there is no parameter here that could carry one. That is what makes a saved
/// filter a filter rather than a remote query channel.
/// </para>
/// <para>
/// Event logs are on demand only: the records come back on
/// this action's result, are shown to the operator who asked, and never reach a
/// telemetry table.
/// </para>
/// </remarks>
public sealed class RunEventLogViewExecutor : IActionExecutor
{
    private static readonly string[] PermittedParameters =
    {
        ActionParameterKeys.EventLogViewId,
        ActionParameterKeys.EventLogViewDefinition,
        ActionParameterKeys.HoursOfHistory,
    };

    private readonly IEventLogReader _reader;
    private readonly ILogger<RunEventLogViewExecutor> _logger;

    /// <summary>Creates the executor.</summary>
    /// <param name="reader">Reads the Windows logs.</param>
    /// <param name="logger">Diagnostic log.</param>
    public RunEventLogViewExecutor(IEventLogReader reader, ILogger<RunEventLogViewExecutor> logger)
    {
        _reader = reader;
        _logger = logger;
    }

    /// <inheritdoc />
    public ActionName Action => ActionName.RunEventLogView;

    /// <inheritdoc />
    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, PermittedParameters, out string unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!ActionParameters.TryGetRequiredString(
                request,
                ActionParameterKeys.EventLogViewDefinition,
                out string raw,
                out string missing))
        {
            return Task.FromResult(ActionOutcome.Denied(missing));
        }

        EventLogViewDefinition? definition;

        try
        {
            definition = JsonSerializer.Deserialize<EventLogViewDefinition>(
                raw, AgentJson.SerializerOptions);
        }
        catch (JsonException e)
        {
            _logger.LogWarning(e, "Action {RequestId} carried an unreadable view definition.", request.Id);

            return Task.FromResult(ActionOutcome.Denied(
                "The view definition on this request could not be read."));
        }

        if (definition is null || definition.LogNames is null || definition.ChannelNames is null ||
            definition.LogNames.Count + definition.ChannelNames.Count == 0)
        {
            // A view naming no logs matches nothing, and an empty grid looks
            // exactly like a healthy cabinet. Refusing is the only answer that
            // does not mislead.
            return Task.FromResult(ActionOutcome.Denied(
                "The view definition names no Windows logs, so it would match nothing."));
        }

        try
        {
            EventLogReader.ValidateDefinition(definition);
        }
        catch (ArgumentException)
        {
            return Task.FromResult(ActionOutcome.Denied("The saved view contains invalid or unbounded fields."));
        }

        try
        {
            var result = _reader.RunViewResult(definition, cancellationToken) with
            {
                ChannelDiscovery = _reader.DiscoverChannels(cancellationToken)
            };
            if (result.ChannelReads is { Count: > 0 } reads &&
                reads.All(c => c.Access != EventChannelAccess.Readable))
                return Task.FromResult(ActionOutcome.Failed(
                    "No selected event channel could be read. See agent channel access before interpreting an empty view."));
            var entries = result.Entries;

            _logger.LogInformation(
                "View '{View}' returned {Count} record(s) over {WindowHours}h.",
                definition.DisplayName,
                entries.Count,
                definition.WindowHours);

            string summary = result.Truncated
                ? $"'{definition.DisplayName}' matched at least {entries.Count} record(s) in the last " +
                  $"{definition.WindowHours}h; the newest {entries.Count} are shown."
                : $"'{definition.DisplayName}' matched {entries.Count} record(s) in the last " +
                  $"{definition.WindowHours}h.";

            if (result.ChannelReads?.Any(c => c.Access != EventChannelAccess.Readable) == true)
                summary += " Record read incomplete; some channels were denied, disabled or unavailable. See channel outcomes.";

            return Task.FromResult(ActionOutcome.Collected(
                summary, JsonSerializer.Serialize(result, AgentJson.SerializerOptions)));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "View '{View}' could not be run.", definition.DisplayName);

            return Task.FromResult(ActionOutcome.Failed(
                $"The view '{definition.DisplayName}' could not be run. {e.Message}"));
        }
    }
}
