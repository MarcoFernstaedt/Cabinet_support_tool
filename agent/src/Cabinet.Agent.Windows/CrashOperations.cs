using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;

namespace Cabinet.Agent.Windows;

/// <summary>
/// crash.list on Windows: the small dumps in %SystemRoot%\Minidump and %SystemRoot%\MEMORY.DMP, found by fixed paths (never a path from a
/// command). Only each small dump's first 4 KB are read, shared with whatever else has it open; links are skipped, so the folder cannot
/// point the broker elsewhere. Runs in the broker (the folder is readable by administrators only). Nothing is changed or copied.
/// </summary>
[SupportedOSPlatform("windows")]
public static class CrashOperations
{
    /// <summary>At most this many entries are looked at, so a folder filled with junk cannot make the read run without end.</summary>
    private const int MaxEntries = 500;

    public static Task<CrashListOutput> ListAsync(EmptyParams p, CancellationToken token)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var folder = new DirectoryInfo(Path.Combine(windows, "Minidump"));
        var found = new List<CrashDumps.FoundFile>();
        bool folderFound = folder.Exists && !folder.Attributes.HasFlag(FileAttributes.ReparsePoint);
        if (folderFound)
        {
            foreach (FileInfo f in folder.EnumerateFiles("*.dmp", new EnumerationOptions { RecurseSubdirectories = false, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint }).Take(MaxEntries))
            {
                token.ThrowIfCancellationRequested();
                if (!CrashDumps.IsDumpName(f.Name)) continue;
                found.Add(new CrashDumps.FoundFile(f.Name, new DateTimeOffset(f.LastWriteTimeUtc, TimeSpan.Zero), f.Length, Head(f)));
            }
        }
        var memory = new FileInfo(Path.Combine(windows, "MEMORY.DMP"));
        MemoryDumpInfo? full = memory.Exists && !memory.Attributes.HasFlag(FileAttributes.ReparsePoint)
            ? new MemoryDumpInfo { WrittenAt = new DateTimeOffset(memory.LastWriteTimeUtc, TimeSpan.Zero), SizeBytes = memory.Length }
            : null;
        return Task.FromResult(CrashDumps.Build(folderFound, found, full, DateTimeOffset.UtcNow));
    }

    /// <summary>The file's first bytes, at most CrashDumps.HeaderBytes; null when Windows refuses or the file is locked.</summary>
    private static byte[]? Head(FileInfo f)
    {
        try
        {
            using var stream = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1, FileOptions.None);
            var buffer = new byte[CrashDumps.HeaderBytes];
            int total = 0, n;
            while (total < buffer.Length && (n = stream.Read(buffer, total, buffer.Length - total)) > 0) total += n;
            return buffer[..total];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
