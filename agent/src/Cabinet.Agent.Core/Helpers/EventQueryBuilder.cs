using System.Globalization;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// Builds the XPath filter the Windows event log service evaluates for
/// eventlog.query. Every part comes from schema-checked fields: levels and
/// event IDs are numbers, times are formatted here, and the one string (the
/// source) is quoted so it can never change the shape of the expression.
/// </summary>
public static class EventQueryBuilder
{
    /// <param name="Filter">The XPath for EventLogQuery.</param>
    /// <param name="SourceInCode">
    /// A source name containing both kinds of quote cannot be written as an
    /// XPath 1.0 literal, so it is matched in code instead of in the filter.
    /// </param>
    public sealed record Query(string Filter, string? SourceInCode);

    public static Query Build(EventlogQueryParams p)
    {
        var clauses = new List<string>();
        if (p.Levels is { Count: > 0 } levels)
        {
            IEnumerable<int> numbers = levels.SelectMany(EventLevels.ToWindows).Distinct().Order();
            clauses.Add("(" + string.Join(" or ", numbers.Select(n => $"Level={n.ToString(CultureInfo.InvariantCulture)}")) + ")");
        }
        string? sourceInCode = null;
        if (p.Source is { } source)
        {
            if (Literal(source) is { } literal) clauses.Add($"Provider[@Name={literal}]");
            else sourceInCode = source;
        }
        if (p.EventIds is { Count: > 0 } ids)
            clauses.Add("(" + string.Join(" or ", ids.Distinct().Order().Select(i => $"EventID={i.ToString(CultureInfo.InvariantCulture)}")) + ")");
        if (p.From is { } from) clauses.Add($"TimeCreated[@SystemTime>='{Time(from)}']");
        if (p.To is { } to) clauses.Add($"TimeCreated[@SystemTime<='{Time(to)}']");
        if (p.BeforeRecordId is { } before) clauses.Add($"EventRecordID<{before.ToString(CultureInfo.InvariantCulture)}");
        string filter = clauses.Count == 0 ? "*" : $"*[System[{string.Join(" and ", clauses)}]]";
        return new Query(filter, sourceInCode);
    }

    /// <summary>The filter for one record (eventlog.get).</summary>
    public static string ForRecord(long recordId) =>
        $"*[System[EventRecordID={recordId.ToString(CultureInfo.InvariantCulture)}]]";

    /// <summary>An XPath 1.0 string literal, or null when the text holds both quote characters.</summary>
    internal static string? Literal(string text) =>
        !text.Contains('\'') ? $"'{text}'" : !text.Contains('"') ? $"\"{text}\"" : null;

    private static string Time(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
}

/// <summary>Windows event levels and the contract's names for them.</summary>
public static class EventLevels
{
    /// <summary>Windows: 1 critical, 2 error, 3 warning, 4 information, 5 verbose. 0 (LogAlways) reads as information.</summary>
    public static EventLevel FromWindows(byte? level) => level switch
    {
        1 => EventLevel.Critical,
        2 => EventLevel.Error,
        3 => EventLevel.Warning,
        5 => EventLevel.Verbose,
        _ => EventLevel.Information,
    };

    public static IEnumerable<int> ToWindows(EventLevel level) => level switch
    {
        EventLevel.Critical => new[] { 1 },
        EventLevel.Error => new[] { 2 },
        EventLevel.Warning => new[] { 3 },
        EventLevel.Information => new[] { 0, 4 },
        _ => new[] { 5 },
    };
}

/// <summary>Text shaping for event output: first line, length limits, no control characters.</summary>
public static class EventText
{
    public static string FirstLine(string? message, int max = 256)
    {
        if (string.IsNullOrEmpty(message)) return "";
        int end = message.IndexOfAny(new[] { '\r', '\n' });
        return ShortText(end < 0 ? message : message[..end], max);
    }

    /// <summary>Single-line text: control characters become spaces, then trimmed and capped.</summary>
    public static string ShortText(string? text, int max = 256)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var chars = text.Select(c => char.IsControl(c) ? ' ' : c).ToArray();
        string clean = new string(chars).Trim();
        return Cap(clean, max);
    }

    /// <summary>Multi-line text: keeps tabs and line breaks, drops other control characters, then caps.</summary>
    public static string LongText(string? text, int max)
    {
        if (string.IsNullOrEmpty(text)) return "";
        string clean = new(text.Where(c => !char.IsControl(c) || c is '\n' or '\r' or '\t').ToArray());
        return Cap(clean, max);
    }

    /// <summary>Cuts at <paramref name="max"/> UTF-16 units without splitting a surrogate pair.</summary>
    public static string Cap(string text, int max)
    {
        if (text.Length <= max) return text;
        int cut = max;
        if (char.IsHighSurrogate(text[cut - 1])) cut--;
        return text[..cut];
    }
}
