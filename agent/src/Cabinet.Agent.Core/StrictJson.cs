using System.Text.Json;

namespace Cabinet.Agent.Core;

/// <summary>
/// Parses untrusted JSON before schema validation: bounded size and depth, no
/// comments or trailing commas, and no duplicate property names. A duplicate
/// name is refused because different readers keep different copies, so
/// "operation" could mean one thing to the validator and another to the code.
/// </summary>
public static class StrictJson
{
    public const int MaxDepth = 32;

    public static bool TryParse(ReadOnlyMemory<byte> utf8, int maxBytes, out JsonDocument? document)
    {
        document = null;
        if (utf8.Length == 0 || utf8.Length > maxBytes) return false;
        try
        {
            var doc = JsonDocument.Parse(utf8, new JsonDocumentOptions
            {
                MaxDepth = MaxDepth, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow,
            });
            if (HasDuplicateNames(doc.RootElement))
            {
                doc.Dispose();
                return false;
            }
            document = doc;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    internal static bool HasDuplicateNames(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (JsonProperty property in element.EnumerateObject())
                    if (!seen.Add(property.Name) || HasDuplicateNames(property.Value)) return true;
                return false;
            case JsonValueKind.Array:
                foreach (JsonElement item in element.EnumerateArray())
                    if (HasDuplicateNames(item)) return true;
                return false;
            default:
                return false;
        }
    }
}
