using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// The platform-independent rules behind the Windows inventory reads: code-to-name mappings and bounds. Plain comparisons and tables,
/// no pattern matching of text.
/// </summary>
public static class InventoryRules
{
    /// <summary>Win32_Share.Type: 0 disk, 1 print queue, 3 IPC; 0x80000000 and up are the administrative shares.</summary>
    public static ShareKind ShareKindFor(long? type, string name)
    {
        if (name == "IPC$") return ShareKind.Ipc;
        if (name == "ADMIN$" || (name.Length == 2 && name[1] == '$' && char.IsAsciiLetter(name[0]))) return ShareKind.Admin;
        return type switch
        {
            0 => ShareKind.Disk,
            1 => ShareKind.Print,
            3 => ShareKind.Ipc,
            >= 2147483648L and <= 2147483651L => ShareKind.Admin,
            _ => ShareKind.Other,
        };
    }

    /// <summary>MSFT_ScheduledTask.State: 0 unknown, 1 disabled, 2 queued, 3 ready, 4 running.</summary>
    public static TaskState TaskStateFor(long? code) => code switch { 1 => TaskState.Disabled, 2 => TaskState.Queued, 3 => TaskState.Ready, 4 => TaskState.Running, _ => TaskState.Unknown };

    /// <summary>WTS_CONNECTSTATE_CLASS.</summary>
    public static SessionState SessionStateFor(int code) => code switch { 0 => SessionState.Active, 1 => SessionState.Connected, 4 => SessionState.Disconnected, 5 => SessionState.Idle, _ => SessionState.Other };

    /// <summary>The console session and the services session are local; a named RDP-Tcp session is remote.</summary>
    public static SessionType SessionTypeFor(string winStationName) => winStationName.StartsWith("RDP-", StringComparison.OrdinalIgnoreCase) ? SessionType.Remote : SessionType.Console;

    /// <summary>Crash and hang events by their Windows event source and id; Windows' own failures (unexpected shutdown, kernel power loss) are 6008 and 41.</summary>
    public static ReliabilityKind ReliabilityKindFor(string source, long? eventId)
    {
        if (source == "Application Error" || eventId == 1000) return ReliabilityKind.AppCrash;
        if (source == "Application Hang" || eventId == 1002) return ReliabilityKind.AppHang;
        if (eventId is 6008 or 41) return ReliabilityKind.WindowsFailure;
        if (source.Contains("Update", StringComparison.OrdinalIgnoreCase)) return ReliabilityKind.UpdateFailure;
        return ReliabilityKind.Other;
    }

    /// <summary>Whole days from <paramref name="now"/> to <paramref name="notAfter"/>, rounded toward the past, never beyond the contract's range.</summary>
    public static long DaysLeft(DateTimeOffset notAfter, DateTimeOffset now) => Math.Clamp((long)Math.Floor((notAfter - now).TotalDays), -36_500, 36_500);

    /// <summary>Whole days since <paramref name="then"/>; null when the time is missing or in the future by more than a day.</summary>
    public static long? AgeDays(DateTimeOffset? then, DateTimeOffset now) => then is null || then > now.AddDays(1) ? null : Math.Max(0, (long)Math.Floor((now - then.Value).TotalDays));

    /// <summary>Registry display names are untrusted text: single line, capped, and null when nothing is left.</summary>
    public static string? Clean(string? text, int max) => EventText.ShortText(text, max) is { Length: > 0 } s ? s : null;

    /// <summary>Keeps at most <paramref name="max"/> items and says whether any were dropped.</summary>
    public static (List<T> Items, bool Truncated) Bound<T>(IEnumerable<T> source, int max)
    {
        var items = new List<T>();
        foreach (T item in source)
        {
            if (items.Count >= max) return (items, true);
            items.Add(item);
        }
        return (items, false);
    }

    /// <summary>A registry date such as "20240115" as "2024-01-15"; anything else is dropped.</summary>
    public static string? CompactDate(string? text)
    {
        if (text is not { Length: 8 } || !text.All(char.IsAsciiDigit)) return null;
        int y = int.Parse(text[..4]), m = int.Parse(text[4..6]), d = int.Parse(text[6..]);
        return y is >= 1990 and <= 2100 && m is >= 1 and <= 12 && d is >= 1 and <= 31 ? $"{y:D4}-{m:D2}-{d:D2}" : null;
    }
}
