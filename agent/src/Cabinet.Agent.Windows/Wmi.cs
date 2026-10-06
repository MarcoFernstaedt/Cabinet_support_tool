using System.Globalization;
using System.Management;
using System.Runtime.Versioning;

namespace Cabinet.Agent.Windows;

/// <summary>
/// WMI queries. Every query text is a constant in this assembly; nothing
/// from a command is ever put into WQL.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class Wmi
{
    public const string CimV2 = @"root\cimv2";
    public const string RootWmi = @"root\wmi";
    public const string Storage = @"root\Microsoft\Windows\Storage";

    public static List<Dictionary<string, object?>> Query(string scope, string wql, int max = 20_000)
    {
        var rows = new List<Dictionary<string, object?>>();
        var options = new System.Management.EnumerationOptions { ReturnImmediately = true, Rewindable = false, Timeout = TimeSpan.FromSeconds(60) };
        using var searcher = new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(wql), options);
        using ManagementObjectCollection results = searcher.Get();
        foreach (ManagementBaseObject item in results)
        {
            using (item)
            {
                var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                foreach (PropertyData p in item.Properties) row[p.Name] = p.Value;
                rows.Add(row);
            }
            if (rows.Count >= max) break;
        }
        return rows;
    }

    public static string? Text(this Dictionary<string, object?> row, string name) =>
        row.TryGetValue(name, out object? v) && v is not null && v.ToString() is { Length: > 0 } s && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;

    public static long? Long(this Dictionary<string, object?> row, string name)
    {
        if (!row.TryGetValue(name, out object? v) || v is null) return null;
        try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException) { return null; }
    }

    public static bool? Bool(this Dictionary<string, object?> row, string name) =>
        row.TryGetValue(name, out object? v) && v is bool b ? b : null;

    public static string[] Strings(this Dictionary<string, object?> row, string name) =>
        row.TryGetValue(name, out object? v) && v is string[] a ? a : Array.Empty<string>();

    /// <summary>A CIM datetime ("20240115000000.000000-000") as UTC.</summary>
    public static DateTimeOffset? Date(this Dictionary<string, object?> row, string name)
    {
        string? text = row.Text(name);
        if (text is null) return null;
        try { return new DateTimeOffset(ManagementDateTimeConverter.ToDateTime(text).ToUniversalTime(), TimeSpan.Zero); }
        catch (Exception e) when (e is ArgumentException or FormatException or ArgumentOutOfRangeException) { return null; }
    }
}
