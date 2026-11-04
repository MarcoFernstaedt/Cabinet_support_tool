using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

/// <summary>crash.list without Windows: kernel small-dump headers (64- and 32-bit) read safely, and the list built within its contract.</summary>
public sealed class CrashDumpsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 2, 3, 15, 40, TimeSpan.Zero);

    private static byte[] Header64(uint code, ulong p1, ulong p2, ulong p3, ulong p4, int length = 4096)
    {
        var b = new byte[length];
        Encoding.ASCII.GetBytes("PAGEDU64").CopyTo(b, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x38), code);
        ulong[] ps = [p1, p2, p3, p4];
        for (int i = 0; i < 4; i++) BinaryPrimitives.WriteUInt64LittleEndian(b.AsSpan(0x40 + 8 * i), ps[i]);
        return b;
    }

    private static byte[] Header32(uint code, uint p1, uint p2, uint p3, uint p4)
    {
        var b = new byte[4096];
        Encoding.ASCII.GetBytes("PAGEDUMP").CopyTo(b, 0);
        // DUMP_HEADER32 (ntiodump.h): after the signature, ValidDump and versions come four ULONG pointers (0x10..0x1F), then
        // MachineImageType at 0x20 and NumberProcessors at 0x24; filled in so a read at the wrong offset cannot pass.
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x20), 0x14C);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x24), 4);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x28), code);
        uint[] ps = [p1, p2, p3, p4];
        for (int i = 0; i < 4; i++) BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0x2C + 4 * i), ps[i]);
        return b;
    }

    private static void MatchesContract(CrashListOutput o) =>
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.CrashList), JsonSerializer.SerializeToElement(o, ContractJson.Options)));

    [Fact]
    public void A_64_bit_small_dump_gives_its_stop_code_and_four_parameters()
    {
        var (h, problem) = CrashDumps.ParseHeader(Header64(0xD1, 0x28, 0x2, 0x0, 0xFFFFF8063C41A2B0));
        Assert.Null(problem);
        Assert.Equal(0xD1, h!.StopCode);
        Assert.Equal(new[] { "0x0000000000000028", "0x0000000000000002", "0x0000000000000000", "0xFFFFF8063C41A2B0" }, h.Parameters);
    }

    [Fact]
    public void A_32_bit_small_dump_is_read_from_its_own_layout()
    {
        var (h, problem) = CrashDumps.ParseHeader(Header32(0x7E, 0xC0000005, 0x8A2B3C4D, 0x1, 0x2));
        Assert.Null(problem);
        Assert.Equal(0x7E, h!.StopCode);
        Assert.Equal("0x00000000C0000005", h.Parameters[0]);
    }

    [Fact]
    public void A_stop_code_with_the_top_bit_set_is_kept_whole()
    {
        Assert.Equal(0xC000021AL, CrashDumps.ParseHeader(Header64(0xC000021A, 0, 0, 0, 0)).Header!.StopCode);
    }

    [Theory]
    [InlineData("")]
    [InlineData("PAGE")]
    [InlineData("PAGEDU64")]                // the signature, then nothing
    [InlineData("PAGEDUMP\u0001")]          // 32-bit signature, cut short
    public void A_cut_short_file_is_too_short_never_read_past_its_end(string text)
    {
        var (h, problem) = CrashDumps.ParseHeader(Encoding.ASCII.GetBytes(text));
        Assert.Null(h);
        Assert.Equal(DumpProblem.TooShort, problem);
    }

    [Theory]
    [InlineData("MDMP\u0093§\u0000\u0000")]   // a user-mode minidump, not a kernel dump
    [InlineData("PAGEXXXX")]
    [InlineData("pagedu64")]
    [InlineData("MZ\u0090\u0000\u0003\u0000\u0000\u0000")]   // a program renamed .dmp
    public void Anything_that_is_not_a_kernel_dump_header_is_said_to_be_so(string text)
    {
        var bytes = new byte[4096];
        Encoding.Latin1.GetBytes(text).CopyTo(bytes, 0);
        Assert.Equal(DumpProblem.NotADump, CrashDumps.ParseHeader(bytes).Problem);
    }

    [Fact]
    public void The_list_is_newest_first_capped_at_50_with_only_valid_names_and_within_the_contract()
    {
        var files = Enumerable.Range(0, 60).Select(i => new CrashDumps.FoundFile($"1102{i:00}-9875-01.dmp", T0.AddHours(-i), 262_144, Header64(0xD1, 0x28, 2, 0, 1))).ToList();
        files.Add(new CrashDumps.FoundFile("..\\..\\SAM.dmp", T0.AddHours(1), 1, Header64(1, 0, 0, 0, 0)));
        files.Add(new CrashDumps.FoundFile("evil name.dmp", T0.AddHours(2), 1, null));
        files.Add(new CrashDumps.FoundFile("notes.DMP", T0.AddHours(3), 1, null));
        files.Add(new CrashDumps.FoundFile("locked-01.dmp", T0.AddHours(4), 300, null));
        files.Add(new CrashDumps.FoundFile("junk-01.dmp", T0.AddHours(5), 4, Encoding.ASCII.GetBytes("abcd")));
        CrashListOutput o = CrashDumps.Build(true, files, new MemoryDumpInfo { WrittenAt = T0, SizeBytes = 805_306_368 }, T0.AddDays(1));
        MatchesContract(o);
        Assert.Equal(CrashDumps.MaxMinidumps, o.Minidumps.Count);
        Assert.True(o.Truncated);
        Assert.Equal(new[] { "junk-01.dmp", "locked-01.dmp" }, o.Minidumps.Take(2).Select(m => m.Name));
        Assert.Equal((DumpProblem?)DumpProblem.TooShort, o.Minidumps[0].Problem);
        Assert.Equal((DumpProblem?)DumpProblem.Unreadable, o.Minidumps[1].Problem);
        Assert.Null(o.Minidumps[1].StopCode);
        Assert.DoesNotContain(o.Minidumps, m => m.Name.Contains("SAM") || m.Name.Contains(' ') || m.Name.EndsWith(".DMP", StringComparison.Ordinal));
        Assert.Equal(0xD1, o.Minidumps[2].StopCode);
    }

    [Fact]
    public void No_folder_and_no_full_dump_is_a_plain_empty_answer()
    {
        CrashListOutput o = CrashDumps.Build(false, [], null, T0);
        MatchesContract(o);
        Assert.False(o.FolderFound);
        Assert.Empty(o.Minidumps);
        Assert.False(o.Truncated);
    }

    [Fact]
    public void A_header_one_byte_short_of_its_fields_is_too_short_and_the_exact_length_is_read()
    {
        byte[] full = Header64(0xD1, 1, 2, 3, 4);
        Assert.Equal(DumpProblem.TooShort, CrashDumps.ParseHeader(full.AsSpan(0, 0x5F)).Problem);
        Assert.Equal(0xD1, CrashDumps.ParseHeader(full.AsSpan(0, 0x60)).Header!.StopCode);
        byte[] small = Header32(0x7E, 1, 2, 3, 4);
        Assert.Equal(DumpProblem.TooShort, CrashDumps.ParseHeader(small.AsSpan(0, 0x3B)).Problem);
        Assert.Equal(0x7E, CrashDumps.ParseHeader(small.AsSpan(0, 0x3C)).Header!.StopCode);
    }
}
