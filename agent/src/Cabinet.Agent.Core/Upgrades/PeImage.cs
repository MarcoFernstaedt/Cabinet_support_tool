using System.Buffers.Binary;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>
/// The Machine field of a PE header: the only honest answer to "what is this program really built for" (the file name
/// and the folder say nothing). The installer reads it the same way before it copies anything; the updater reads it
/// here to refuse a release whose programs are built for the other architecture, before the swap.
/// </summary>
public static class PeImage
{
    /// <summary>Where a PE file keeps the offset of its "PE\0\0" header.</summary>
    private const int HeaderPointerAt = 0x3C;

    /// <summary>"PE\0\0" as a little-endian 32-bit value.</summary>
    private const uint Signature = 0x0000_4550;

    /// <returns>The Machine field, or null when the file is not a Windows program or its header is damaged.</returns>
    public static int? Machine(string path)
    {
        using FileStream file = File.OpenRead(path);
        if (file.Length < HeaderPointerAt + 4) return null;

        Span<byte> word = stackalloc byte[4];
        Span<byte> pair = stackalloc byte[2];
        if (file.Read(pair) != 2 || pair[0] != 'M' || pair[1] != 'Z') return null;

        file.Seek(HeaderPointerAt, SeekOrigin.Begin);
        if (file.Read(word) != 4) return null;
        int header = BinaryPrimitives.ReadInt32LittleEndian(word);
        // A header that points outside the file, or at a place where a header cannot start, is damage rather than a program.
        if (header < HeaderPointerAt || header + 6 > file.Length) return null;

        file.Seek(header, SeekOrigin.Begin);
        if (file.Read(word) != 4 || BinaryPrimitives.ReadUInt32LittleEndian(word) != Signature) return null;
        if (file.Read(pair) != 2) return null;
        return BinaryPrimitives.ReadUInt16LittleEndian(pair);
    }
}
