using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>Path rules and paging for files.list, beyond what the schema already enforces.</summary>
public static class FilesListing
{
    private static readonly string[] DeviceNames =
    {
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>
    /// The canonical directory path, or null when the path names a device or
    /// a component Windows would silently rewrite (trailing dot or space).
    /// </summary>
    public static string? Canonical(string path)
    {
        if (path.Length < 3 || !(path[0] is 'C' or 'c') || path[1] != ':' || path[2] != '\\') return null;
        string[] parts = path[3..].Split('\\', StringSplitOptions.None);
        var kept = new List<string>();
        for (int i = 0; i < parts.Length; i++)
        {
            string part = parts[i];
            if (part.Length == 0)
            {
                if (i == parts.Length - 1) continue; // one trailing separator
                return null;                          // doubled separators
            }
            if (part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ')) return null;
            string stem = part.Split('.')[0].TrimEnd();
            if (DeviceNames.Contains(stem, StringComparer.OrdinalIgnoreCase)) return null;
            kept.Add(part);
        }
        return "C:\\" + string.Join('\\', kept);
    }

    /// <summary>Every directory from the root down to the path, so each can be checked for reparse points.</summary>
    public static IEnumerable<string> SelfAndAncestors(string canonical)
    {
        yield return "C:\\";
        string[] parts = canonical[3..].Split('\\', StringSplitOptions.RemoveEmptyEntries);
        for (int i = 1; i <= parts.Length; i++) yield return "C:\\" + string.Join('\\', parts.Take(i));
    }

    /// <summary>Directories first, then files, each by name; then one page of the result.</summary>
    public static (IReadOnlyList<FileEntry> Entries, bool HasMore) Page(IEnumerable<FileEntry> all, int page, int pageSize)
    {
        var ordered = all.OrderBy(e => e.Type == FileEntryType.Directory ? 0 : 1)
            .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase).ThenBy(e => e.Name, StringComparer.Ordinal);
        long skip = (long)(page - 1) * pageSize;
        var slice = ordered.Skip((int)Math.Min(skip, int.MaxValue)).Take(pageSize + 1).ToList();
        bool hasMore = slice.Count > pageSize;
        if (hasMore) slice.RemoveAt(slice.Count - 1);
        return (slice, hasMore);
    }
}
