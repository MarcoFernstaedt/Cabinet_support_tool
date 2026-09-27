using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Actions;

/// <summary>Validates untrusted inspection data before completing or storing an action.</summary>
public static class FirewallResultValidator
{
    // 128 rows * 5 strings * 256 characters * 6 escaped bytes, plus metadata.
    // The outer JSON string may escape these backslashes again; its separate
    // pre-binding ceiling is deliberately larger. No structured data is truncated.
    public const int MaximumPayloadBytes = 1_100_000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 12,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter() }
    };

    public static bool IsValid(ActionResultDto result, DateTimeOffset now)
    {
        if (!Enum.IsDefined(result.Status) || result.CompletedAtUtc == default ||
            result.CompletedAtUtc > now.AddMinutes(5) || result.Output?.Length > 8000 ||
            result.StartedAtUtc is { } started && (started == default || started > result.CompletedAtUtc)) return false;
        if (result.CollectedData is null) return result.Status != ActionStatus.Succeeded;
        if (result.CollectedData.Length > MaximumPayloadBytes ||
            Encoding.UTF8.GetByteCount(result.CollectedData) > MaximumPayloadBytes) return false;
        try
        {
            using var document = JsonDocument.Parse(result.CollectedData, new JsonDocumentOptions { MaxDepth = 12 });
            if (document.RootElement.ValueKind != JsonValueKind.Object || HasDuplicateProperties(document.RootElement)) return false;
            var inspection = JsonSerializer.Deserialize<FirewallInspection>(result.CollectedData, Json);
            if (inspection is null || inspection.Version != 1 || inspection.ObservedUtc == default ||
                inspection.ObservedUtc > result.CompletedAtUtc || !Enum.IsDefined(inspection.Status) ||
                inspection.Profiles is null || inspection.Rules is null ||
                inspection.Profiles.Count > 3 || inspection.Rules.Count > 128 ||
                !Text(inspection.Note, 1024) || !Text(inspection.PolicyCaveat, 1024)) return false;
            if (inspection.Profiles.Any(p => p is null || p.Profile is not (1 or 2 or 4) || !Enum.IsDefined(p.Status)) ||
                inspection.Profiles.Select(p => p.Profile).Distinct().Count() != inspection.Profiles.Count) return false;
            return inspection.Rules.All(r => r is not null && Text(r.Name, 256) && Text(r.LocalPorts, 256) &&
                Text(r.RemotePorts, 256) && Text(r.LocalAddresses, 256) && Text(r.RemoteAddresses, 256));
        }
        catch (JsonException) { return false; }
    }

    private static bool Text(string? value, int limit) => value is not null && value.Length <= limit &&
        !value.Any(c => char.IsControl(c) || char.GetUnicodeCategory(c) == UnicodeCategory.Format);

    private static bool HasDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var property in element.EnumerateObject())
                if (!names.Add(property.Name) || HasDuplicateProperties(property.Value)) return true;
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var value in element.EnumerateArray())
                if (HasDuplicateProperties(value)) return true;
        return false;
    }
}
