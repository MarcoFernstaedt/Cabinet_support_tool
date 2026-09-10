using System.Globalization;

namespace CabinetPlatform.Agent.Platform.Wmi;

/// <summary>
/// Parses the CIM DATETIME strings WMI returns for date-valued properties,
/// for example <c>20240115103000.000000-300</c>.
/// </summary>
/// <remarks>
/// The trailing signed number is an offset from UTC in <em>minutes</em>, not
/// hours, and the fractional part is microseconds. Treating either the way the
/// more familiar ISO-8601 format works silently shifts every timestamp the
/// agent reports, which is precisely the kind of error that only shows up when
/// somebody is trying to correlate an event log entry with a dispensing record.
/// </remarks>
public static class CimDateTime
{
    /// <summary>Interval-valued CIM datetimes carry a ':' in the offset field.</summary>
    private const char IntervalMarker = ':';

    public static DateTimeOffset? TryParse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length < 21)
        {
            return null;
        }

        // An interval is a duration, not a point in time. It has no meaningful
        // conversion to DateTimeOffset, so it is rejected rather than coerced.
        if (value[21 - 1] == IntervalMarker || value.Contains(IntervalMarker, StringComparison.Ordinal))
        {
            return null;
        }

        var datePart = value[..14];
        if (!DateTime.TryParseExact(
                datePart,
                "yyyyMMddHHmmss",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var localWallClock))
        {
            return null;
        }

        var microsecondsPart = value.Substring(15, 6);
        if (!int.TryParse(microsecondsPart, NumberStyles.None, CultureInfo.InvariantCulture, out var microseconds))
        {
            microseconds = 0;
        }

        var sign = value[21];
        var offsetPart = value[22..];
        if (!int.TryParse(offsetPart, NumberStyles.None, CultureInfo.InvariantCulture, out var offsetMinutes))
        {
            return null;
        }

        if (sign == '-')
        {
            offsetMinutes = -offsetMinutes;
        }
        else if (sign != '+')
        {
            return null;
        }

        // Offsets outside this range are not representable and indicate a
        // malformed value rather than an exotic time zone.
        if (offsetMinutes is < -14 * 60 or > 14 * 60)
        {
            return null;
        }

        var withFraction = localWallClock.AddTicks(microseconds * (TimeSpan.TicksPerMillisecond / 1000));

        try
        {
            return new DateTimeOffset(withFraction, TimeSpan.FromMinutes(offsetMinutes));
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }
}
