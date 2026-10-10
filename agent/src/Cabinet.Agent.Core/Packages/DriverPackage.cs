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

    public const long MaxCheckedFileBytes = 32L * 1024 * 1024;

    /// <summary>
    /// Before anything is unpacked: reads only the INF and catalog files (each at most 32 MB) from the zip into memory and
    /// checks each INF's device class, that it names a catalog in the package, and that the catalog is signed by a trusted
    /// publisher. A package that fails is refused without writing a single file. <see cref="Check"/> runs again on the
    /// unpacked files and also checks every other file against the catalogs.
    /// </summary>
    public static void PreCheck(string zipPath, TrustList trust)
    {
        try
        {
            using ZipArchive zip = ZipFile.OpenRead(zipPath);
            if (zip.Entries.Count > MaxEntries) throw new PackageRefusedException("verification_failed", "The package has too many files.");
            var byName = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (ZipArchiveEntry e in zip.Entries)
            {
                string name = e.FullName.Replace('\\', '/');
                if (name.EndsWith('/')) continue;
                if (!SafeName(name)) throw new PackageRefusedException("verification_failed", "The package contains a file name that is not allowed.");
                if (!byName.TryAdd(name, e)) throw new PackageRefusedException("verification_failed", "The package contains the same file twice.");
            }
            var infs = byName.Keys.Where(n => n.EndsWith(".inf", StringComparison.OrdinalIgnoreCase)).ToList();
            if (infs.Count == 0) throw new PackageRefusedException("verification_failed", "The package has no INF file.");
            foreach (string inf in infs)
            {
                byte[] infBytes = Read(byName[inf]);
                var cats = CatalogFilesOf(infBytes);
                if (cats.Count == 0) throw new PackageRefusedException("signature_invalid", $"{inf} does not name a signed catalog.");
                string? cls = ClassOf(infBytes);
                if (cls is null || !AllowedClasses.Contains(cls))
                    throw new PackageRefusedException("verification_failed", $"{inf} is for device class \"{cls ?? "none"}\", which library packages may not install.");
                string dir = inf.Contains('/') ? inf[..(inf.LastIndexOf('/') + 1)] : "";
                foreach (string cat in cats)
                {
                    if (!byName.TryGetValue(dir + cat, out ZipArchiveEntry? entry))
                        throw new PackageRefusedException("signature_invalid", $"The catalog {cat} named by {inf} is not in the package.");
                    DriverCatalog parsed = DriverCatalog.Parse(Read(entry));
                    if (trust.Match(parsed.Signature.Signer, parsed.Signature.Certificates, Contracts.PackageType.Driver) is null)
                        throw new PackageRefusedException("publisher_not_trusted", "The package's catalog is not signed by a trusted publisher.");
                }
            }
        }
        catch (InvalidDataException) { throw new PackageRefusedException("verification_failed", "The package is not a valid zip file."); }
        catch (NotSupportedException) { throw new PackageRefusedException("verification_failed", "The package uses a zip feature that is not allowed (such as encryption)."); }
    }

    private static byte[] Read(ZipArchiveEntry e)
    {
        using Stream input = e.Open();
        using var buffer = new MemoryStream();
        byte[] chunk = new byte[81920];
        int n;
        while ((n = input.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (buffer.Length + n > MaxCheckedFileBytes) throw new PackageRefusedException("verification_failed", "An INF or catalog in the package is larger than allowed.");
            buffer.Write(chunk, 0, n);
        }
        return buffer.ToArray();
    }

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

    /// <summary>
    /// The device classes a library driver package may install: the cabinet's peripherals, its network and its storage
    /// controller. "Microsoft Windows Hardware Compatibility Publisher" signs nearly every certified driver, including
    /// kernel drivers known to be exploitable, so the signer alone is not enough: a package for any other class (System,
    /// SoftwareComponent, a legacy kernel service, or no class) is refused. Compiled in; the server cannot widen it.
    /// </summary>
    public static readonly IReadOnlySet<string> AllowedClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Biometric", "USB", "USBDevice", "HIDClass", "Keyboard", "Mouse", "Ports", "Image", "Camera", "Printer", "SmartCardReader",
        "Net", "Bluetooth", "SCSIAdapter", "HDC", "Display", "Monitor", "MEDIA", "Extension",
    };

    /// <summary>The device class an INF declares in its [Version] section (Class=), or null.</summary>
    public static string? ClassOf(byte[] inf) => VersionValues(inf, key => key.Equals("Class", StringComparison.OrdinalIgnoreCase)).FirstOrDefault();

    /// <summary>The catalog file an INF names in its [Version] section (CatalogFile, or a platform-specific CatalogFile.NTxxx).</summary>
    public static IReadOnlyList<string> CatalogFilesOf(byte[] inf) =>
        VersionValues(inf, key => key.Equals("CatalogFile", StringComparison.OrdinalIgnoreCase) || key.StartsWith("CatalogFile.", StringComparison.OrdinalIgnoreCase));

    private static IReadOnlyList<string> VersionValues(byte[] inf, Func<string, bool> wanted)
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
            if (!wanted(key)) continue;
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
            byte[] infBytes = File.ReadAllBytes(Path.Combine(folder, inf));
            var names = CatalogFilesOf(infBytes);
            if (names.Count == 0) throw new PackageRefusedException("signature_invalid", $"{Path.GetFileName(inf)} does not name a signed catalog.");
            string? cls = ClassOf(infBytes);
            if (cls is null || !AllowedClasses.Contains(cls))
                throw new PackageRefusedException("verification_failed", $"{Path.GetFileName(inf)} is for device class \"{cls ?? "none"}\", which library packages may not install.");
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
