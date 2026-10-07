using System.Formats.Asn1;
using System.Security.Cryptography;

namespace Cabinet.Agent.Core.Packages;

/// <summary>
/// A driver catalog (.cat): a signed certificate trust list whose members are the hashes of
/// every file in the driver package. A file belongs to the package only if one of its
/// hashes is a member (docs/spec/04-agent-spec.md "Driver package").
/// </summary>
public sealed class DriverCatalog
{
    public required SignedData Signature { get; init; }
    /// <summary>Member digests, as lower-case hex.</summary>
    public required HashSet<string> Members { get; init; }

    public static DriverCatalog Parse(byte[] catFile)
    {
        SignedData signed = SignedData.Verify(catFile);
        if (signed.ContentType != SignedData.OidCtl) throw new PackageRefusedException("signature_invalid", "The catalog is not a certificate trust list.");
        var members = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            var ctl = new AsnReader(signed.ContentEncoded, AsnEncodingRules.BER).ReadSequence();
            // Walk the trust list: every SPC_INDIRECT_DATA attribute carries one file's digest.
            while (ctl.HasData)
            {
                Asn1Tag tag = ctl.PeekTag();
                if (!tag.HasSameClassAndValue(Asn1Tag.Sequence)) { ctl.ReadEncodedValue(); continue; }
                var subjects = ctl.ReadSequence();
                while (subjects.HasData)
                {
                    if (!subjects.PeekTag().HasSameClassAndValue(Asn1Tag.Sequence)) { subjects.ReadEncodedValue(); continue; }
                    var subject = subjects.ReadSequence();
                    if (!subject.HasData || !subject.PeekTag().HasSameClassAndValue(Asn1Tag.PrimitiveOctetString)) continue;
                    subject.ReadOctetString(); // the member tag
                    if (!subject.HasData || !subject.PeekTag().HasSameClassAndValue(Asn1Tag.SetOf)) continue;
                    var attrs = subject.ReadSetOf();
                    while (attrs.HasData)
                    {
                        var attr = attrs.ReadSequence();
                        if (attr.ReadObjectIdentifier() != SignedData.OidSpcIndirectData) continue;
                        var values = attr.ReadSetOf();
                        var indirect = values.ReadSequence();
                        indirect.ReadEncodedValue(); // SpcAttributeTypeAndOptionalValue
                        var digestInfo = indirect.ReadSequence();
                        digestInfo.ReadSequence(); // algorithm
                        members.Add(Convert.ToHexString(digestInfo.ReadOctetString()).ToLowerInvariant());
                    }
                }
            }
        }
        catch (AsnContentException) { throw new PackageRefusedException("signature_invalid", "The catalog's member list is malformed."); }
        return new DriverCatalog { Signature = signed, Members = members };
    }

    /// <summary>Whether this file (as bytes) is a member: by its Authenticode hash if it is a Windows executable, else by its plain hash.</summary>
    public bool Covers(byte[] file)
    {
        foreach (byte[] digest in Digests(file))
            if (Members.Contains(Convert.ToHexString(digest).ToLowerInvariant())) return true;
        return false;
    }

    /// <summary>Catalogs list SHA-1 member hashes (version 1) or SHA-256 ones (version 2); both are tried. The catalog's own signature is SHA-256.</summary>
    public static IEnumerable<byte[]> Digests(byte[] file)
    {
        if (PeImage.TryAuthenticodeRanges(file, out var ranges))
        {
            yield return HashRanges(SHA256.Create(), file, ranges);
            yield return HashRanges(SHA1.Create(), file, ranges);
        }
        yield return SHA256.HashData(file);
        yield return SHA1.HashData(file);
    }

    private static byte[] HashRanges(HashAlgorithm h, byte[] file, IReadOnlyList<(int Start, int Length)> ranges)
    {
        using (h)
        {
            foreach (var (start, length) in ranges) h.TransformBlock(file, start, length, null, 0);
            h.TransformFinalBlock([], 0, 0);
            return h.Hash!;
        }
    }
}

/// <summary>
/// The parts of a Windows executable (.sys, .dll, .exe) its Authenticode hash covers: the whole
/// file except the header checksum, the certificate-table directory entry and the certificate table.
/// </summary>
public static class PeImage
{
    public static bool TryAuthenticodeRanges(byte[] f, out IReadOnlyList<(int Start, int Length)> ranges)
    {
        ranges = Array.Empty<(int, int)>();
        if (f.Length < 0x40 || f[0] != 'M' || f[1] != 'Z') return false;
        int pe = BitConverter.ToInt32(f, 0x3C);
        if (pe < 0x40 || pe > f.Length - 24 || f[pe] != 'P' || f[pe + 1] != 'E' || f[pe + 2] != 0 || f[pe + 3] != 0) return false;
        int optional = pe + 24;
        if (optional + 2 > f.Length) return false;
        ushort magic = BitConverter.ToUInt16(f, optional);
        int certDir = magic switch { 0x10b => optional + 128, 0x20b => optional + 144, _ => -1 };
        if (certDir < 0 || certDir + 8 > f.Length) return false;
        int checksum = optional + 64;
        uint certOffset = BitConverter.ToUInt32(f, certDir);
        uint certSize = BitConverter.ToUInt32(f, certDir + 4);
        var list = new List<(int, int)> { (0, checksum), (checksum + 4, certDir - (checksum + 4)) };
        if (certSize == 0) list.Add((certDir + 8, f.Length - (certDir + 8)));
        else
        {
            if (certOffset < certDir + 8 || certOffset + (long)certSize > f.Length) return false;
            list.Add((certDir + 8, (int)certOffset - (certDir + 8)));
            // Anything after the certificate table is still covered, so data appended to a signed file changes its hash.
            int after = (int)(certOffset + certSize);
            if (after < f.Length) list.Add((after, f.Length - after));
        }
        ranges = list;
        return true;
    }
}
