using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Cabinet-bound saved Event Viewer action results.</summary>
[ApiController]
[Route("api/cabinets/{cabinetId:guid}/event-log-results")]
public sealed class EventLogResultsController : ControllerBase
{
    private const int MaxEntries = 100;
    private const int MaxChannels = 20;
    private const int MaxBytes = 120 * 1024;
    private readonly SupportDbContext _db;

    public EventLogResultsController(SupportDbContext db) => _db = db;

    [HttpGet("latest")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(EventLogLatestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<EventLogLatestResult>> Latest(Guid cabinetId, CancellationToken ct)
    {
        ActionRequest? action = await _db.ActionRequests.AsNoTracking()
            .Where(a => a.CabinetId == cabinetId && a.Action == ActionName.RunEventLogView)
            .OrderByDescending(a => a.RequestedUtc).ThenByDescending(a => a.Id)
            .FirstOrDefaultAsync(ct);
        return ProjectResponse(action);
    }

    [HttpGet("{actionId:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(EventLogLatestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<EventLogLatestResult>> ByAction(Guid cabinetId, Guid actionId, CancellationToken ct)
    {
        ActionRequest? action = await _db.ActionRequests.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Id == actionId && a.CabinetId == cabinetId &&
                a.Action == ActionName.RunEventLogView, ct);
        return ProjectResponse(action);
    }

    private ActionResult<EventLogLatestResult> ProjectResponse(ActionRequest? action)
    {
        if (action is null) return NotFound();

        try
        {
            EventLogLatestResult projection = Project(action);
            return Ok(projection);
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException)
        {
            // Neither stored parameters nor agent output are a trusted web response.
            return StatusCode(StatusCodes.Status502BadGateway);
        }
    }

    private static EventLogLatestResult Project(ActionRequest action)
    {
        using JsonDocument parameters = JsonDocument.Parse(action.ParametersJson);
        JsonElement p = parameters.RootElement;
        RejectDuplicateProperties(p);
        if (p.ValueKind != JsonValueKind.Object ||
            !p.TryGetProperty(ActionParameterKeys.EventLogViewId, out JsonElement idElement) ||
            !Guid.TryParse(idElement.GetString(), out Guid id) || id == Guid.Empty ||
            !p.TryGetProperty(ActionParameterKeys.EventLogViewDefinition, out JsonElement definitionElement))
            throw new JsonException("Invalid stored view request.");
        string? rawDefinition = definitionElement.GetString();
        if (rawDefinition is null) throw new JsonException("Missing view definition.");
        using JsonDocument definitionJson = JsonDocument.Parse(rawDefinition);
        JsonElement def = definitionJson.RootElement;
        RejectDuplicateProperties(def);
        RequireProperties(def, "viewId", "displayName", "windowHours", "maximumEntries");
        EventLogViewDefinition definition = JsonSerializer.Deserialize<EventLogViewDefinition>(rawDefinition, ContractJson.Default)
            ?? throw new JsonException("Missing view definition.");
        if (definition.ViewId != id || string.IsNullOrWhiteSpace(definition.DisplayName) ||
            definition.DisplayName.Length > 160 || definition.WindowHours < 1 || definition.MaximumEntries < 1 ||
            definition.LogNames is null || definition.ChannelNames is null || definition.Sources is null ||
            definition.LogNames.Count + definition.ChannelNames.Count is < 1 or > MaxChannels ||
            definition.Sources.Count > 50 ||
            (p.TryGetProperty(ActionParameterKeys.HoursOfHistory, out JsonElement hours) &&
             hours.GetString() != definition.WindowHours.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            throw new JsonException("Invalid stored view definition.");
        string[] channels = definition.LogNames.Select(n => n.ToString()).Concat(definition.ChannelNames).ToArray();
        if (definition.LogNames.Any(n => !Enum.IsDefined(n)) ||
            channels.Any(n => string.IsNullOrWhiteSpace(n) || n.Length > 512) ||
            channels.Distinct(StringComparer.OrdinalIgnoreCase).Count() != channels.Length ||
            definition.Sources.Any(s => string.IsNullOrWhiteSpace(s) || s.Trim().Length > 255))
            throw new JsonException("Invalid requested channels or providers.");
        // The Agent builds its provider query from trimmed names; report and verify that effective scope.
        string[] providers = definition.Sources.Select(s => s.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

        bool completed = action.Status == ActionRequestStatus.Completed;
        bool succeeded = completed && action.ResultStatus == ActionStatus.Succeeded;
        string state = completed || action.Status is ActionRequestStatus.Denied or ActionRequestStatus.Expired or ActionRequestStatus.Cancelled
            ? "failed" : "pending";
        var reads = new List<EventLogChannelReadProjection>();
        var entries = new List<EventLogEntryProjection>();
        bool truncated = false;
        if (succeeded)
        {
            if (string.IsNullOrWhiteSpace(action.CollectedDataJson)) throw new JsonException("Missing event view result.");
            using JsonDocument resultJson = JsonDocument.Parse(action.CollectedDataJson);
            RejectDuplicateProperties(resultJson.RootElement);
            RequireProperties(resultJson.RootElement, "viewId", "viewDisplayName", "windowHours", "entries", "truncated");
            EventLogViewResultDto result = JsonSerializer.Deserialize<EventLogViewResultDto>(action.CollectedDataJson, ContractJson.Default)
                ?? throw new JsonException("Missing event view result.");
            if (result.ViewId != definition.ViewId || result.ViewDisplayName != definition.DisplayName ||
                result.WindowHours != definition.WindowHours || result.Entries is null ||
                result.Entries.Count > definition.MaximumEntries || result.ChannelReads?.Count > MaxChannels)
                throw new JsonException("Event result does not match its request.");
            if (result.ChannelReads is not null)
            {
                foreach (EventChannelReadResult read in result.ChannelReads)
                {
                    if (read is null || !channels.Contains(read.Name, StringComparer.OrdinalIgnoreCase) ||
                        !Enum.IsDefined(read.Access) || read.RecordsRead < 0 || read.RecordsRead > definition.MaximumEntries ||
                        reads.Any(r => string.Equals(r.ChannelName, read.Name, StringComparison.OrdinalIgnoreCase)))
                        throw new JsonException("Invalid channel read.");
                    reads.Add(new EventLogChannelReadProjection
                    {
                        ChannelName = read.Name, Outcome = JsonNamingPolicy.CamelCase.ConvertName(read.Access.ToString()),
                        RecordsRead = read.RecordsRead, Truncated = read.Truncated
                    });
                }
            }
            if (result.ChannelReads is not null && reads.Count != channels.Length)
                throw new JsonException("Missing channel read outcomes.");
            foreach (EventLogEntry entry in result.Entries)
            {
                if (entry is null || entry.TimeCreatedUtc == default || entry.EventId < 0 ||
                    !Enum.IsDefined(entry.Level) || entry.ChannelName is { } native &&
                    (entry.LogName is not null && native != entry.LogName.ToString()) ||
                    entry.ChannelName is null && entry.LogName is null ||
                    !channels.Contains(entry.DisplayChannelName, StringComparer.OrdinalIgnoreCase) ||
                    providers.Length > 0 && (entry.Source is null ||
                        !providers.Contains(entry.Source, StringComparer.OrdinalIgnoreCase)))
                    throw new JsonException("Invalid event identity.");
                if (entry.Message?.Length > 512 || entry.Source?.Length > 255) truncated = true;
                entries.Add(new EventLogEntryProjection
                {
                    Channel = entry.DisplayChannelName, Provider = Limit(entry.Source, 255),
                    Level = JsonNamingPolicy.CamelCase.ConvertName(entry.Level.ToString()),
                    EventId = entry.EventId, OccurredAt = entry.TimeCreatedUtc, Message = Limit(entry.Message, 512)
                });
            }
            truncated |= result.Truncated;
            state = reads.Count == 0 || reads.Any(r => r.Outcome != "readable") ? "partial" : "complete";
        }
        EventLogLatestResult Make() => new()
        {
            CabinetId = action.CabinetId, ActionId = action.Id, State = state,
            RequestedAtUtc = action.RequestedUtc, CompletedAtUtc = completed ? action.CompletedUtc : null,
            ViewId = definition.ViewId, ViewDisplayName = definition.DisplayName,
            RequestedChannels = channels, RequestedProviders = providers,
            ChannelReads = reads, Truncated = truncated, Entries = entries
        };
        while (entries.Count > MaxEntries) { entries.RemoveAt(entries.Count - 1); truncated = true; }
        while (JsonSerializer.SerializeToUtf8Bytes(Make(), ContractJson.Default).Length > MaxBytes && entries.Count > 0)
        {
            entries.RemoveAt(entries.Count - 1);
            truncated = true;
        }
        if (JsonSerializer.SerializeToUtf8Bytes(Make(), ContractJson.Default).Length > MaxBytes)
            throw new JsonException("Event result projection exceeds the response limit.");
        return Make();
    }

    private static string? Limit(string? value, int length) =>
        value is { Length: > 0 } && value.Length > length ? value[..length] : value;

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray()) RejectDuplicateProperties(item);
        }
        else if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new JsonException("Duplicate property in stored event view data.");
                RejectDuplicateProperties(property.Value);
            }
        }
    }

    private static void RequireProperties(JsonElement element, params string[] properties)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            properties.Any(name => !element.TryGetProperty(name, out JsonElement value) || value.ValueKind == JsonValueKind.Null))
            throw new JsonException("Required view fields missing.");
    }
}
