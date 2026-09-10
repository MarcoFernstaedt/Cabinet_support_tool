using System.Globalization;

namespace CabinetPlatform.Agent.Platform.Wmi;

/// <summary>
/// One row of a WMI query, reduced to plain CLR values.
/// </summary>
/// <remarks>
/// Collectors depend on this rather than on <c>ManagementBaseObject</c> so that
/// a test can hand a collector a realistic row without a WMI provider being
/// present. The typed accessors all return null for an absent or unconvertible
/// property: a value the agent could not read is reported as unknown, never as
/// a zero that would read as a healthy measurement.
/// </remarks>
public sealed class WmiRecord
{
    private readonly IReadOnlyDictionary<string, object?> _values;

    public WmiRecord(IReadOnlyDictionary<string, object?> values)
    {
        _values = new Dictionary<string, object?>(values, StringComparer.OrdinalIgnoreCase);
    }

    public IEnumerable<string> PropertyNames => _values.Keys;

    public object? GetRaw(string name) => _values.TryGetValue(name, out var value) ? value : null;

    public string? GetString(string name)
    {
        var value = GetRaw(name);
        if (value is null)
        {
            return null;
        }

        if (value is string text)
        {
            return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
        }

        if (value is string[] many)
        {
            var joined = string.Join(", ", many.Where(s => !string.IsNullOrWhiteSpace(s)));
            return string.IsNullOrWhiteSpace(joined) ? null : joined;
        }

        return Convert.ToString(value, CultureInfo.InvariantCulture)?.Trim() is { Length: > 0 } converted
            ? converted
            : null;
    }

    public IReadOnlyList<string> GetStringArray(string name)
    {
        var value = GetRaw(name);
        return value switch
        {
            string[] many => many.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).ToArray(),
            string single when !string.IsNullOrWhiteSpace(single) => new[] { single.Trim() },
            _ => Array.Empty<string>(),
        };
    }

    public long? GetInt64(string name) => ConvertNumber(GetRaw(name), Convert.ToInt64);

    public int? GetInt32(string name)
    {
        var asLong = GetInt64(name);
        if (asLong is null)
        {
            return null;
        }

        return asLong is > int.MaxValue or < int.MinValue ? null : (int)asLong.Value;
    }

    public double? GetDouble(string name) => ConvertNumber(GetRaw(name), Convert.ToDouble);

    public bool? GetBoolean(string name)
    {
        var value = GetRaw(name);
        return value switch
        {
            null => null,
            bool flag => flag,
            string text when bool.TryParse(text, out var parsed) => parsed,
            _ => TryConvertBoolean(value),
        };
    }

    public byte[]? GetBytes(string name)
    {
        var value = GetRaw(name);
        return value switch
        {
            byte[] bytes => bytes,
            // Some providers surface a byte array as an array of boxed numbers.
            Array array => ConvertArrayToBytes(array),
            _ => null,
        };
    }

    public DateTimeOffset? GetDateTime(string name)
    {
        var value = GetRaw(name);
        return value switch
        {
            null => null,
            DateTime dateTime => new DateTimeOffset(DateTime.SpecifyKind(dateTime, DateTimeKind.Local)),
            DateTimeOffset dateTimeOffset => dateTimeOffset,
            string text => CimDateTime.TryParse(text),
            _ => null,
        };
    }

    private static T? ConvertNumber<T>(object? value, Func<object, T> convert)
        where T : struct
    {
        if (value is null)
        {
            return null;
        }

        if (value is string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }

            try
            {
                return convert(text);
            }
            catch (Exception e) when (e is FormatException or OverflowException or InvalidCastException)
            {
                return null;
            }
        }

        try
        {
            return convert(value);
        }
        catch (Exception e) when (e is FormatException or OverflowException or InvalidCastException)
        {
            return null;
        }
    }

    private static bool? TryConvertBoolean(object value)
    {
        try
        {
            return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
        {
            return null;
        }
    }

    private static byte[]? ConvertArrayToBytes(Array array)
    {
        var bytes = new byte[array.Length];
        for (var i = 0; i < array.Length; i++)
        {
            var element = array.GetValue(i);
            if (element is null)
            {
                return null;
            }

            try
            {
                bytes[i] = Convert.ToByte(element, CultureInfo.InvariantCulture);
            }
            catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
            {
                return null;
            }
        }

        return bytes;
    }
}
