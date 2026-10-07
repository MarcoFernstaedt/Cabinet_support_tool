using System.IO.Compression;
using System.Text;

namespace Cabinet.Agent.Core.Packages;

/// <summary>
/// A driver package (a zip with the INF, its signed catalog and its binaries), unpacked safely
/// into the broker's staging folder and checked: every INF names a catalog in the package, every
/// catalog's signature verifies and its signer is a trusted publisher, and every other file is a
/// member of one of those catalogs. Nothing here installs anything.
/// </summary>
public static class DriverPackage
{
    public const int MaxEntries = 2000;
    public const long MaxTotalBytes = 2L * 1024 * 1024 * 1024;
    public const long MaxEntryBytes = 512L * 1024 * 1024;

    /// <summary>Unpacks into <paramref name="target"/>, refusing unsafe names, duplicates, encryption and oversize content.</summary>
    /// <returns>The relative paths of the files written.</returns>
    public static IReadOnlyList<string> Extract(string zipPath, string target, long maxEntryBytes = MaxEntryBytes, long maxTotalBytes = MaxTotalBytes)
    {
        Directory.CreateDirectory(target);
        string root = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
        var written = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        try
        {
            using ZipArchive zip = ZipFile.OpenRead(zipPath);
            if (zip.Entries.Count > MaxEntries) throw new PackageRefusedException("verification_failed", "The package has too many files.");
            foreach (ZipArchiveEntry e in zip.Entries)
            {
                string name = e.FullName.Replace('\\', '/');
                if (name.EndsWith('/')) continue; // a folder
                if (!SafeName(name)) throw new PackageRefusedException("verification_failed", "The package contains a file name that is not allowed.");
                if (!seen.Add(name)) throw new PackageRefusedException("verification_failed", "The package contains the same file twice.");
                string path = Path.GetFullPath(Path.Combine(root, name));
                if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new PackageRefusedException("verification_failed", "The package tries to write outside its folder.");
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                using Stream input = e.Open();
                using FileStream output = new(path, FileMode.CreateNew, FileAccess.Write);
                // Count what is actually inflated; the sizes in the zip header are not trusted.
                byte[] buffer = new byte[81920];
                long size = 0;
                int n;
                while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    size += n; total += n;
                    if (size > maxEntryBytes || total > maxTotalBytes) throw new PackageRefusedException("verification_failed", "The package unpacks to more than is allowed.");
                    output.Write(buffer, 0, n);
                }
                written.Add(name);
            }
        }
        catch (InvalidDataException) { throw new PackageRefusedException("verification_failed", "The package is not a valid zip file."); }
        catch (NotSupportedException) { throw new PackageRefusedException("verification_failed", "The package uses a zip feature that is not allowed (such as encryption)."); }
        return written;
    }

    /// <summary>Plain relative names only: no drive, no root, no "..", no control or reserved characters.</summary>
    public static bool SafeName(string name)
    {
        if (name.Length is 0 or > 240 || name.StartsWith('/')) return false;
        foreach (string part in name.Split('/'))
        {
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith('.') || part.EndsWith(' ')) return false;
            foreach (char c in part)
                if (c < 0x20 || c == 0x7f || ":*?\"<>|".Contains(c)) return false;
            string stem = part.Split('.')[0].ToUpperInvariant();
            if (stem is "CON" or "PRN" or "AUX" or "NUL" || (stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) && char.IsDigit(stem[3]))) return false;
        }
        return true;
    }

    /// <summary>The catalog file an INF names in its [Version] section (CatalogFile, or a platform-specific CatalogFile.NTxxx).</summary>
    public static IReadOnlyList<string> CatalogFilesOf(byte[] inf)
    {
        string text = Decode(inf);
        var found = new List<string>();
        bool inVersion = false;
        foreach (string raw in text.Split('\n'))
        {
            string line = StripComment(raw).Trim();
            if (line.Length == 0) continue;
            if (line.StartsWith('[') && line.EndsWith(']')) { inVersion = line[1..^1].Trim().Equals("Version", StringComparison.OrdinalIgnoreCase); continue; }
            if (!inVersion) continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string key = line[..eq].Trim();
            if (!key.Equals("CatalogFile", StringComparison.OrdinalIgnoreCase) && !key.StartsWith("CatalogFile.", StringComparison.OrdinalIgnoreCase)) continue;
            string value = line[(eq + 1)..].Trim().Trim('"').Trim();
            if (value.Length > 0) found.Add(value);
        }
        return found;
    }

    private static string Decode(byte[] b) =>
        b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE ? Encoding.Unicode.GetString(b, 2, b.Length - 2)
        : b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF ? Encoding.UTF8.GetString(b, 3, b.Length - 3)
        : Encoding.Latin1.GetString(b);

    private static string StripComment(string line)
    {
        bool quoted = false;
        for (int i = 0; i < line.Length; i++)
        {
            if (line[i] == '"') quoted = !quoted;
            else if (line[i] == ';' && !quoted) return line[..i];
        }
        return line;
    }

    /// <summary>
    /// Checks an unpacked package: returns the INF files to install and the signer that vouches for them.
    /// Throws <see cref="PackageRefusedException"/> with signature_invalid, publisher_not_trusted or verification_failed.
    /// </summary>
    public static (IReadOnlyList<string> Infs, string Signer) Check(string folder, IReadOnlyList<string> files, TrustList trust)
    {
        var infs = files.Where(f => f.EndsWith(".inf", StringComparison.OrdinalIgnoreCase)).ToList();
        if (infs.Count == 0) throw new PackageRefusedException("verification_failed", "The package has no INF file.");
        var catalogs = new Dictionary<string, DriverCatalog>(StringComparer.OrdinalIgnoreCase);
        string? signer = null;
        foreach (string inf in infs)
        {
            string dir = Path.GetDirectoryName(inf.Replace('/', Path.DirectorySeparatorChar)) ?? "";
            var names = CatalogFilesOf(File.ReadAllBytes(Path.Combine(folder, inf)));
            if (names.Count == 0) throw new PackageRefusedException("signature_invalid", $"{Path.GetFileName(inf)} does not name a signed catalog.");
            foreach (string cat in names)
            {
                string rel = Path.Combine(dir, cat).Replace(Path.DirectorySeparatorChar, '/');
                string? actual = files.FirstOrDefault(f => f.Equals(rel, StringComparison.OrdinalIgnoreCase));
                if (actual is null) throw new PackageRefusedException("signature_invalid", $"The catalog {cat} named by {Path.GetFileName(inf)} is not in the package.");
                if (catalogs.ContainsKey(actual)) continue;
                DriverCatalog parsed = DriverCatalog.Parse(File.ReadAllBytes(Path.Combine(folder, actual)));
                var publisher = trust.Match(parsed.Signature.Signer, parsed.Signature.Certificates, Contracts.PackageType.Driver)
                    ?? throw new PackageRefusedException("publisher_not_trusted", $"The catalog is signed by \"{parsed.Signature.Signer.GetNameInfo(System.Security.Cryptography.X509Certificates.X509NameType.SimpleName, false)}\", which is not a trusted publisher.");
                signer ??= publisher.Name;
                catalogs[actual] = parsed;
            }
        }
        foreach (string f in files)
        {
            if (catalogs.ContainsKey(f)) continue;
            byte[] content = File.ReadAllBytes(Path.Combine(folder, f));
            if (!catalogs.Values.Any(c => c.Covers(content)))
                throw new PackageRefusedException("signature_invalid", $"{f} is not covered by the package's signed catalog (it may have been changed).");
        }
        return (infs, signer!);
    }
}
