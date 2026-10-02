using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Actions;

/// <summary>Closed schema for machine WER metadata. Never accepts signature values or report contents.</summary>
public static class WerMetadataValidator
{
    public const int MaxStoredBytes = 8192;
    private static readonly string[] RootFields = ["version", "observedUtc", "stores", "reports"];
    private static readonly string[] StoreFields = ["store", "status", "truncated"];
    private static readonly string[] ReportFields = ["reportId", "createdUtc", "eventType", "store"];
    private static readonly HashSet<string> EventTypes = ["APPCRASH", "BEX", "BEX64", "CLR20r3", "MoAppCrash", "AppHangB1"];

    public static bool TryValidate(string? raw, DateTimeOffset nowUtc, out WerMetadataResult? metadata)
    {
        metadata = null;
        if (raw is null || Encoding.UTF8.GetByteCount(raw) > MaxStoredBytes) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 4 });
            JsonElement root = document.RootElement;
            if (!Fields(root, RootFields) || root.GetProperty("version").ValueKind != JsonValueKind.Number ||
                !root.GetProperty("version").TryGetInt32(out int version) || version != 1 ||
                !Utc(root.GetProperty("observedUtc"), out DateTimeOffset observed) ||
                observed > nowUtc.AddMinutes(5) || observed < nowUtc.AddDays(-7) ||
                root.GetProperty("stores").ValueKind != JsonValueKind.Array ||
                root.GetProperty("reports").ValueKind != JsonValueKind.Array) return false;
            JsonElement stores = root.GetProperty("stores");
            JsonElement reports = root.GetProperty("reports");
            if (stores.GetArrayLength() != 2 || reports.GetArrayLength() > 40) return false;
            var outcomes = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (JsonElement row in stores.EnumerateArray())
            {
                if (!Fields(row, StoreFields) || !Store(row.GetProperty("store"), out string store) ||
                    !EnumName<WerStoreStatus>(row.GetProperty("status"), out string status) || status == "Unknown" ||
                    row.GetProperty("truncated").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                    row.GetProperty("truncated").GetBoolean() && status != "Partial" ||
                    !outcomes.TryAdd(store, status)) return false;
            }
            if (!outcomes.ContainsKey("MachineQueue") || !outcomes.ContainsKey("MachineArchive")) return false;
            var ids = new HashSet<Guid>();
            foreach (JsonElement row in reports.EnumerateArray())
            {
                if (!Fields(row, ReportFields) || !Store(row.GetProperty("store"), out string store) ||
                    outcomes[store] is not ("Read" or "Partial") ||
                    row.GetProperty("reportId").ValueKind != JsonValueKind.String ||
                    !row.GetProperty("reportId").TryGetGuid(out Guid id) || id == Guid.Empty || !ids.Add(id) ||
                    !Utc(row.GetProperty("createdUtc"), out DateTimeOffset created) ||
                    created > observed || created < observed.AddDays(-7) ||
                    row.GetProperty("eventType").ValueKind != JsonValueKind.String ||
                    !EventTypes.Contains(row.GetProperty("eventType").GetString()!)) return false;
            }
            metadata = JsonSerializer.Deserialize<WerMetadataResult>(raw, ContractJson.Default);
            return metadata is not null;
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
        var valid = allowed.ToHashSet(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
            if (!valid.Contains(property.Name) || !names.Add(property.Name)) return false;
        return names.SetEquals(valid);
    }

    private static bool Store(JsonElement element, out string name) =>
        EnumName<WerStore>(element, out name) && name is "MachineQueue" or "MachineArchive";

    private static bool EnumName<T>(JsonElement element, out string name) where T : struct, Enum
    {
        name = element.ValueKind == JsonValueKind.String ? element.GetString() ?? "" : "";
        return Enum.GetNames<T>().Contains(name, StringComparer.Ordinal);
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
