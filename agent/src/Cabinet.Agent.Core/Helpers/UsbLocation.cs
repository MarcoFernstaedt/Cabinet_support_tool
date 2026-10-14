namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// The hub and port numbers in a USB device's location text, such as "Port_#0003.Hub_#0001". Plain string handling, no patterns: the text
/// comes from the registry and is treated as untrusted.
/// </summary>
public static class UsbLocation
{
    public static (int? Hub, int? Port) Parse(string? location)
    {
        if (string.IsNullOrEmpty(location) || location.Length > 200) return (null, null);
        return (Number(location, "Hub_#"), Number(location, "Port_#"));
    }

    private static int? Number(string text, string marker)
    {
        int at = text.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0) return null;
        int start = at + marker.Length, end = start;
        while (end < text.Length && end - start < 6 && text[end] is >= '0' and <= '9') end++;
        if (end == start) return null;
        int value = 0;
        for (int i = start; i < end; i++) value = value * 10 + (text[i] - '0');
        return value <= 65535 ? value : null;
    }

    /// <summary>A USB hub, from its name or class; everything else under USB is a device.</summary>
    public static string KindOf(string name, string? deviceClass) =>
        name.Contains("hub", StringComparison.OrdinalIgnoreCase) && string.Equals(deviceClass, "USB", StringComparison.OrdinalIgnoreCase) ? "hub" : "device";
}
