using System.Collections;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Configuration;

/// <summary>
/// The fingerprint of a category: SHA-256 of its canonical JSON, the same rule the server applies when it recomputes the hash
/// (server/src/services/config-canonical.ts), with shared vectors in contracts/vectors/config-hash-vectors.json. Canonical:
/// items sorted by key, object keys sorted ordinally at every level, no spaces, arrays in their own order, whole numbers only,
/// strings escaped as JSON.stringify does (quote, backslash, control characters), everything else as it is.
/// </summary>
public static class ConfigCanonical
{
    public static string Json(IEnumerable<ConfigItem> items)
    {
        var text = new StringBuilder("[");
        bool first = true;
        foreach (ConfigItem item in items.OrderBy(i => i.Key, StringComparer.Ordinal))
        {
            if (!first) text.Append(',');
            first = false;
            text.Append("{\"key\":");
            WriteString(text, item.Key);
            text.Append(",\"values\":");
            WriteObject(text, item.Values.Select(v => (v.Key, v.Value)));
            text.Append('}');
        }
        return text.Append(']').ToString();
    }

    public static string Hash(IEnumerable<ConfigItem> items) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Json(items)))).ToLowerInvariant();

    /// <summary>The length of one item in the canonical JSON (with its separator), so a category can be kept under a size budget.</summary>
    public static int ItemLength(ConfigItem item) => Json([item]).Length - 1;

    private static void WriteObject(StringBuilder text, IEnumerable<(string Key, object? Value)> members)
    {
        text.Append('{');
        bool first = true;
        foreach (var (key, value) in members.OrderBy(m => m.Key, StringComparer.Ordinal))
        {
            if (!first) text.Append(',');
            first = false;
            WriteString(text, key);
            text.Append(':');
            WriteValue(text, value);
        }
        text.Append('}');
    }

    private static void WriteValue(StringBuilder text, object? value)
    {
        switch (value)
        {
            case null: text.Append("null"); break;
            case string s: WriteString(text, s); break;
            case bool b: text.Append(b ? "true" : "false"); break;
            case int or long or short or byte or uint or ushort: text.Append(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture)); break;
            case JsonElement e: WriteElement(text, e); break;
            case IEnumerable<string> list:
                text.Append('[');
                text.Append(string.Join(',', list.Select(s => { var one = new StringBuilder(); WriteString(one, s); return one.ToString(); })));
                text.Append(']');
                break;
            default: throw new ArgumentException($"A configuration value cannot be a {value.GetType().Name}.");
        }
    }

    private static void WriteElement(StringBuilder text, JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Null: text.Append("null"); break;
            case JsonValueKind.True: text.Append("true"); break;
            case JsonValueKind.False: text.Append("false"); break;
            case JsonValueKind.String: WriteString(text, e.GetString()!); break;
            case JsonValueKind.Number: text.Append(e.GetInt64().ToString(CultureInfo.InvariantCulture)); break;
            case JsonValueKind.Array:
                text.Append('[');
                text.Append(string.Join(',', e.EnumerateArray().Select(x => { var one = new StringBuilder(); WriteElement(one, x); return one.ToString(); })));
                text.Append(']');
                break;
            case JsonValueKind.Object: WriteObject(text, e.EnumerateObject().Select(p => (p.Name, (object?)p.Value))); break;
            default: throw new ArgumentException("Unsupported JSON value.");
        }
    }

    private static void WriteString(StringBuilder text, string s)
    {
        text.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': text.Append("\\\""); break;
                case '\\': text.Append("\\\\"); break;
                case '\b': text.Append("\\b"); break;
                case '\f': text.Append("\\f"); break;
                case '\n': text.Append("\\n"); break;
                case '\r': text.Append("\\r"); break;
                case '\t': text.Append("\\t"); break;
                case < ' ': text.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture)); break;
                default: text.Append(c); break;
            }
        }
        text.Append('"');
    }
}
