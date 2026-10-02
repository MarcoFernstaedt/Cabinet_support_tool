using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Common;

namespace CabinetPlatform.Server.Actions;

/// <summary>Closed, bounded schema for saved display observations. Never stores arbitrary agent fields.</summary>
public static class DisplayResultValidator
{
    public const int MaxStoredBytes = 4096;
    private static readonly string[] RootFields = ["observedAtUtc", "modeStatus", "modes", "modesTruncated",
        "scalingStatus", "scalingPercent", "magnifierStatus", "appZoomStatus"];
    private static readonly string[] RowFields = ["displayIndex", "widthPixels", "heightPixels", "refreshHz"];

    public static bool TryValidate(string? raw, out DisplayDiagnostics? display)
    {
        display = null;
        if (raw is null || Encoding.UTF8.GetByteCount(raw) > MaxStoredBytes) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 4 });
            JsonElement root = document.RootElement;
            if (!Fields(root, RootFields, RootFields) ||
                !Utc(root.GetProperty("observedAtUtc")) ||
                !EnumName<DisplayModeStatus>(root.GetProperty("modeStatus")) ||
                !EnumName<DisplaySessionStatus>(root.GetProperty("scalingStatus")) ||
                !EnumName<DisplaySessionStatus>(root.GetProperty("magnifierStatus")) ||
                !EnumName<DisplaySessionStatus>(root.GetProperty("appZoomStatus")) ||
                root.GetProperty("modesTruncated").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                root.GetProperty("modes").ValueKind != JsonValueKind.Array)
                return false;
            JsonElement modes = root.GetProperty("modes");
            if (modes.GetArrayLength() > 8) return false;
            string modeStatus = root.GetProperty("modeStatus").GetString()!;
            if ((modeStatus == "Observed") != (modes.GetArrayLength() > 0) ||
                root.GetProperty("modesTruncated").GetBoolean() && modes.GetArrayLength() != 8 ||
                modeStatus != "Observed" && root.GetProperty("modesTruncated").GetBoolean()) return false;
            if (root.TryGetProperty("scalingPercent", out JsonElement scaling) && scaling.ValueKind != JsonValueKind.Null)
                return false; // No interactive-session source reports a measured scaling value in this contract.
            int index = 0;
            foreach (JsonElement row in modes.EnumerateArray())
            {
                if (!Fields(row, RowFields, RowFields.Where(n => n != "refreshHz")) ||
                    !Integer(row.GetProperty("displayIndex"), 0, 7, out int displayIndex) || displayIndex != index++ ||
                    !Integer(row.GetProperty("widthPixels"), 1, 16384, out _) ||
                    !Integer(row.GetProperty("heightPixels"), 1, 16384, out _)) return false;
                if (row.TryGetProperty("refreshHz", out JsonElement refresh) &&
                    refresh.ValueKind != JsonValueKind.Null && !Integer(refresh, 1, 1000, out _)) return false;
            }
            display = JsonSerializer.Deserialize<DisplayDiagnostics>(raw, ContractJson.Default);
            return display is not null;
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException or FormatException or OverflowException)
        {
            return false;
        }
    }

    private static bool Fields(JsonElement element, IEnumerable<string> allowed, IEnumerable<string> required)
    {
        if (element.ValueKind != JsonValueKind.Object) return false;
        var names = new HashSet<string>(StringComparer.Ordinal);
        var valid = allowed.ToHashSet(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
            if (!valid.Contains(property.Name) || !names.Add(property.Name)) return false;
        return required.All(names.Contains);
    }

    private static bool Integer(JsonElement element, int min, int max, out int value)
    {
        value = 0;
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out value) && value >= min && value <= max;
    }

    private static bool EnumName<T>(JsonElement element) where T : struct, Enum =>
        element.ValueKind == JsonValueKind.String &&
        Enum.GetNames<T>().Contains(element.GetString(), StringComparer.Ordinal);

    private static bool Utc(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.String) return false;
        string? text = element.GetString();
        return text is not null && (text.EndsWith('Z') || text.EndsWith("+00:00", StringComparison.Ordinal)) &&
            element.TryGetDateTimeOffset(out DateTimeOffset date) && date.Offset == TimeSpan.Zero && date != default;
    }
}
