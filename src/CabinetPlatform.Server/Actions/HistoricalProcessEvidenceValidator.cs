using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Actions;

/// <summary>Closed, bounded wire schema for local process start/exit clues only.</summary>
public static class HistoricalProcessEvidenceValidator
{
    public const int MaxStoredBytes = 16 * 1024;
    private static readonly string[] RootFields = ["version", "observedUtc", "windowStartUtc", "status", "auditCoverageVerified", "truncated", "events"];
    private static readonly string[] EventFields = ["occurredUtc", "kind", "processId", "recordId"];

    public static bool TryValidate(string? raw, DateTimeOffset nowUtc, out HistoricalProcessEvidenceResult? evidence)
    {
        evidence = null;
        if (raw is null || Encoding.UTF8.GetByteCount(raw) > MaxStoredBytes) return false;
        try
        {
            using JsonDocument doc = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 4 });
            JsonElement root = doc.RootElement;
            if (!Fields(root, RootFields) || !root.GetProperty("version").TryGetInt32(out int version) || version != 1 ||
                !Utc(root.GetProperty("observedUtc"), out DateTimeOffset observed) ||
                observed > nowUtc.AddMinutes(5) || observed < nowUtc.AddDays(-7) ||
                !Utc(root.GetProperty("windowStartUtc"), out DateTimeOffset start) ||
                observed - start != TimeSpan.FromDays(1) ||
                root.GetProperty("auditCoverageVerified").ValueKind != JsonValueKind.False ||
                !EnumName(root.GetProperty("status"), out string status) ||
                root.GetProperty("truncated").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                root.GetProperty("events").ValueKind != JsonValueKind.Array) return false;
            bool truncated = root.GetProperty("truncated").GetBoolean();
            JsonElement events = root.GetProperty("events");
            if (events.GetArrayLength() > 64 || (truncated && status != "Partial") ||
                (status is "Denied" or "Unavailable" && (events.GetArrayLength() != 0 || truncated))) return false;
            var ids = new HashSet<long>();
            foreach (JsonElement row in events.EnumerateArray())
            {
                if (!Fields(row, EventFields) || !Utc(row.GetProperty("occurredUtc"), out DateTimeOffset occurred) ||
                    occurred < start || occurred > observed ||
                    row.GetProperty("kind").ValueKind != JsonValueKind.String ||
                    row.GetProperty("kind").GetString() is not ("Start" or "Exit") ||
                    row.GetProperty("processId").ValueKind != JsonValueKind.Number ||
                    !row.GetProperty("processId").TryGetUInt32(out uint pid) || pid == 0) return false;
                JsonElement id = row.GetProperty("recordId");
                if (id.ValueKind == JsonValueKind.Null) continue;
                if (id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out long recordId) || recordId <= 0 || !ids.Add(recordId)) return false;
            }
            evidence = JsonSerializer.Deserialize<HistoricalProcessEvidenceResult>(raw, ContractJson.Default);
            return evidence is not null;
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException or FormatException or OverflowException)
        {
            return false;
        }
    }

    private static bool Fields(JsonElement element, IEnumerable<string> allowed)
    {
        if (element.ValueKind != JsonValueKind.Object) return false;
        var names = new HashSet<string>(StringComparer.Ordinal);
        var expected = allowed.ToHashSet(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
            if (!expected.Contains(property.Name) || !names.Add(property.Name)) return false;
        return names.SetEquals(expected);
    }

    private static bool EnumName(JsonElement element, out string name)
    {
        name = element.ValueKind == JsonValueKind.String ? element.GetString() ?? "" : "";
        return name is "Read" or "Partial" or "Denied" or "Unavailable";
    }

    private static bool Utc(JsonElement element, out DateTimeOffset value)
    {
        value = default;
        if (element.ValueKind != JsonValueKind.String) return false;
        string? text = element.GetString();
        return text is not null && (text.EndsWith('Z') || text.EndsWith("+00:00", StringComparison.Ordinal)) &&
            element.TryGetDateTimeOffset(out value) && value.Offset == TimeSpan.Zero && value != default;
    }
}
