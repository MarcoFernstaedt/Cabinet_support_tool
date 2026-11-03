using System.Buffers.Binary;
using System.Globalization;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>
/// crash.list without Windows: the header of a kernel small dump, and the list built from the files the Windows side found. Only the header
/// (at most HeaderBytes) is ever read; no dump leaves the cabinet. A file is treated as hostile: every offset is checked against what was
/// read, and anything that is not a kernel dump header is said to be so rather than guessed at.
/// </summary>
public static class CrashDumps
{
    public const int MaxMinidumps = 50, HeaderBytes = 4096;

    // DUMP_HEADER64: "PAGE" then "DU64"; BugCheckCode (ULONG) at 0x38, four ULONG64 parameters from 0x40.
    // DUMP_HEADER32: "PAGE" then "DUMP"; BugCheckCode (ULONG) at 0x20, four ULONG parameters from 0x24.
    private static ReadOnlySpan<byte> Page => "PAGE"u8;
    private static ReadOnlySpan<byte> Du64 => "DU64"u8;
    private static ReadOnlySpan<byte> Dump => "DUMP"u8;

    public sealed record Header(long StopCode, IReadOnlyList<string> Parameters);

    /// <summary>The stop code and parameters from the first bytes of a dump, or why they could not be read.</summary>
    public static (Header? Header, DumpProblem? Problem) ParseHeader(ReadOnlySpan<byte> head)
    {
        if (head.Length < 8) return (null, DumpProblem.TooShort);
        if (!head[..4].SequenceEqual(Page)) return (null, DumpProblem.NotADump);
        ReadOnlySpan<byte> kind = head.Slice(4, 4);
        if (kind.SequenceEqual(Du64))
        {
            if (head.Length < 0x60) return (null, DumpProblem.TooShort);
            uint code = BinaryPrimitives.ReadUInt32LittleEndian(head.Slice(0x38, 4));
            var p = new List<string>(4);
            for (int i = 0; i < 4; i++) p.Add(Hex(BinaryPrimitives.ReadUInt64LittleEndian(head.Slice(0x40 + 8 * i, 8))));
            return (new Header(code, p), null);
        }
        if (kind.SequenceEqual(Dump))
        {
            if (head.Length < 0x34) return (null, DumpProblem.TooShort);
            uint code = BinaryPrimitives.ReadUInt32LittleEndian(head.Slice(0x20, 4));
            var p = new List<string>(4);
            for (int i = 0; i < 4; i++) p.Add(Hex(BinaryPrimitives.ReadUInt32LittleEndian(head.Slice(0x24 + 4 * i, 4))));
            return (new Header(code, p), null);
        }
        return (null, DumpProblem.NotADump);
    }

    private static string Hex(ulong v) => "0x" + v.ToString("X16", CultureInfo.InvariantCulture);

    /// <summary>A small dump's file name exactly as the contract allows it: 1 to 64 letters, digits, dots, dashes or underscores, then ".dmp".</summary>
    public static bool IsDumpName(string name)
    {
        if (!name.EndsWith(".dmp", StringComparison.Ordinal)) return false;
        string stem = name[..^4];
        return stem.Length is >= 1 and <= 64 && stem.All(c => c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '.' or '_' or '-');
    }

    /// <summary>One file the Windows side found: its name, time, size, and the first bytes it read (null when Windows refused).</summary>
    public sealed record FoundFile(string Name, DateTimeOffset WrittenAt, long SizeBytes, byte[]? Head);

    /// <summary>The output from what was found: valid names only, newest first, at most 50.</summary>
    public static CrashListOutput Build(bool folderFound, IEnumerable<FoundFile> files, MemoryDumpInfo? memoryDump, DateTimeOffset now)
    {
        var dumps = files.Where(f => IsDumpName(f.Name)).OrderByDescending(f => f.WrittenAt).ThenBy(f => f.Name, StringComparer.Ordinal).ToList();
        var listed = dumps.Take(MaxMinidumps).Select(f =>
        {
            var (header, problem) = f.Head is null ? (null, DumpProblem.Unreadable) : ParseHeader(f.Head.AsSpan(0, Math.Min(f.Head.Length, HeaderBytes)));
            return new MinidumpInfo
            {
                Name = f.Name, WrittenAt = f.WrittenAt, SizeBytes = Math.Max(0, f.SizeBytes),
                StopCode = header?.StopCode, Parameters = header?.Parameters, Problem = header is null ? problem : null,
            };
        }).ToList();
        return new CrashListOutput { TakenAt = now, FolderFound = folderFound, Minidumps = listed, MemoryDump = memoryDump, Truncated = dumps.Count > MaxMinidumps };
    }
}
