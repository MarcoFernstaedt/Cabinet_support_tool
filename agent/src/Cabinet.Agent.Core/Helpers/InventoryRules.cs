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

    /// <summary>The contracts' shortText cap (common.schema.json). A field capped above it fails the whole operation's own output check.</summary>
    public const int ShortTextMax = 256;

    /// <summary>One reliability record, every text field within its contract cap (a long Windows message once failed the whole read).</summary>
    public static ReliabilityRecord ReliabilityRecordFor(DateTimeOffset at, string? source, string? product, long? eventId, string? message)
    {
        string named = Clean(source, 120) ?? "Unknown";
        return new ReliabilityRecord
        {
            At = at, Source = named, Product = Clean(product, 120), EventId = eventId,
            Kind = ReliabilityKindFor(named, eventId), Message = EventText.FirstLine(message, ShortTextMax),
        };
    }

    /// <summary>One DNS cache entry within its contract caps; null when it has no name.</summary>
    public static DnsCacheEntry? DnsCacheEntryFor(string? name, long? type, string? data, long? ttlSeconds)
    {
        string? n = Clean(name, 253);
        if (n is null) return null;
        return new DnsCacheEntry
        {
            Name = n,
            Type = type switch { 1 => "A", 2 => "NS", 5 => "CNAME", 12 => "PTR", 15 => "MX", 16 => "TXT", 28 => "AAAA", 33 => "SRV", var t => $"{t}" },
            Data = Clean(data, ShortTextMax) ?? "",
            TtlSeconds = Math.Clamp(ttlSeconds ?? 0, 0, 2_000_000),
        };
    }

    /// <summary>A program started at sign-in, its command within the contract cap (a long command line once failed the whole read).</summary>
    public static StartupItem StartupItemFor(string? name, string? command, string? location) => new()
    {
        Name = Clean(name, 200) ?? "(unnamed)", Command = Clean(command, ShortTextMax) ?? "", Location = Clean(location, 200) ?? "",
    };

    /// <summary>A shared folder, its path within the contract cap (Windows allows paths far longer than 256 characters).</summary>
    public static ShareInfo ShareInfoFor(string? name, string? path, string? description, long? type)
    {
        string named = Clean(name, 80) ?? "(unnamed)";
        return new ShareInfo { Name = named, Path = Clean(path, ShortTextMax), Description = Clean(description, 200), Kind = ShareKindFor(type, named) };
    }

    /// <summary>A certificate near or past its expiry, its subject within the contract cap.</summary>
    public static CertificateExpiry CertificateExpiryFor(string store, string? subject, DateTimeOffset notAfter, DateTimeOffset now)
    {
        long days = DaysLeft(notAfter, now);
        return new CertificateExpiry { Store = store, Subject = Clean(subject, ShortTextMax) ?? "(no subject)", NotAfter = notAfter, DaysLeft = days, Expired = days < 0 };
    }

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
