using System.Globalization;

namespace CabinetPlatform.Console.Core.Presentation;

/// <summary>
/// Turns values into the strings shown on screen and read aloud.
/// </summary>
/// <remarks>
/// Centralised for one reason above the others: <c>null</c> must never become
/// <c>"0"</c>, <c>"0 B"</c> or <c>"Healthy"</c> anywhere in this console. Every
/// helper here renders an absent value as "Not reported", and every caller gets
/// that for free instead of deciding case by case.
/// </remarks>
public static class Format
{
    public const string NotReported = "Not reported";

    public static string Percent(double? value) => value is null
        ? NotReported
        : value.Value.ToString("0.#", CultureInfo.CurrentCulture) + "%";

    public static string Bytes(long? value)
    {
        if (value is null)
        {
            return NotReported;
        }

        double bytes = value.Value;

        if (bytes < 0)
        {
            return NotReported;
        }

        string[] units = { "B", "KB", "MB", "GB", "TB", "PB" };
        int unit = 0;

        while (bytes >= 1024 && unit < units.Length - 1)
        {
            bytes /= 1024;
            unit++;
        }

        return string.Create(CultureInfo.CurrentCulture, $"{bytes:0.##} {units[unit]}");
    }

    public static string Count(int? value) => value is null
        ? NotReported
        : value.Value.ToString("N0", CultureInfo.CurrentCulture);

    public static string Count(long? value) => value is null
        ? NotReported
        : value.Value.ToString("N0", CultureInfo.CurrentCulture);

    public static string Text(string? value) =>
        string.IsNullOrWhiteSpace(value) ? NotReported : value.Trim();

    /// <summary>
    /// A UTC instant shown in the internal support desk's fixed MST (UTC−7).
    /// Never follows the workstation zone or daylight saving. The legacy method
    /// name is retained for existing bindings; transport and storage remain UTC.
    /// </summary>
    public static string LocalTime(DateTimeOffset? instant)
    {
        if (instant is null)
        {
            return NotReported;
        }

        DateTimeOffset local = instant.Value.ToOffset(TimeSpan.FromHours(-7));

        return local.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture) + " (MST)";
    }

    /// <summary>
    /// An instant shown in a <em>cabinet's</em> zone, labelled with it.
    /// </summary>
    /// <remarks>
    /// The fleet spans thirteen countries, so "02:00" on a cabinet detail view
    /// is meaningless without saying whose 02:00. A cabinet that has not
    /// reported a zone this host can resolve says so rather than silently
    /// falling back to the reader's own, which would be a wrong answer
    /// presented as a right one.
    /// </remarks>
    /// <param name="instant">The instant to show.</param>
    /// <param name="timeZoneId">The cabinet's reported time zone.</param>
    public static string CabinetTime(DateTimeOffset? instant, string? timeZoneId)
    {
        if (instant is null)
        {
            return NotReported;
        }

        if (string.IsNullOrWhiteSpace(timeZoneId))
        {
            return "Cabinet time zone not reported";
        }

        try
        {
            TimeZoneInfo zone = TimeZoneInfo.FindSystemTimeZoneById(timeZoneId);
            DateTimeOffset local = TimeZoneInfo.ConvertTime(instant.Value, zone);

            return local.ToString("yyyy-MM-dd HH:mm:ss ", CultureInfo.CurrentCulture) + zone.StandardName;
        }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            return $"Unknown time zone ({timeZoneId.Trim()})";
        }
    }

    /// <summary>
    /// How long ago, in words. Used for check-in age, where "22 minutes ago"
    /// answers the question a timestamp only lets the reader work out.
    /// </summary>
    public static string Age(DateTimeOffset? instant, DateTimeOffset nowUtc)
    {
        if (instant is null)
        {
            return "Never";
        }

        TimeSpan elapsed = nowUtc - instant.Value;

        if (elapsed < TimeSpan.Zero)
        {
            // The cabinet's clock is ahead of the server's. Saying "in 4
            // minutes" would be absurd; saying "just now" would hide a clock
            // drift problem worth noticing.
            return "Clock ahead of server";
        }

        return elapsed switch
        {
            { TotalSeconds: < 60 } => "Just now",
            { TotalMinutes: < 60 } => Plural((int)elapsed.TotalMinutes, "minute") + " ago",
            { TotalHours: < 24 } => Plural((int)elapsed.TotalHours, "hour") + " ago",
            _ => Plural((int)elapsed.TotalDays, "day") + " ago"
        };
    }

    public static string Duration(TimeSpan? value)
    {
        if (value is null)
        {
            return NotReported;
        }

        TimeSpan span = value.Value;

        if (span < TimeSpan.Zero)
        {
            return NotReported;
        }

        if (span.TotalDays >= 1)
        {
            return $"{Plural((int)span.TotalDays, "day")}, {Plural(span.Hours, "hour")}";
        }

        if (span.TotalHours >= 1)
        {
            return $"{Plural(span.Hours, "hour")}, {Plural(span.Minutes, "minute")}";
        }

        return Plural(Math.Max(0, (int)span.TotalMinutes), "minute");
    }

    private static string Plural(int value, string noun) =>
        value == 1 ? $"1 {noun}" : $"{value.ToString("N0", CultureInfo.CurrentCulture)} {noun}s";
}
