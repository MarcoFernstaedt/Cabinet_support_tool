using System.Formats.Asn1;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Cabinet.Agent.Core.Packages;

namespace Cabinet.Agent.Core.Tests;

/// <summary>A small test PKI: a root, an intermediate and signing certificates, and a catalog signer.</summary>
public sealed class TestPki
{
    public X509Certificate2 Root { get; }
    public X509Certificate2 Intermediate { get; }
    public X509Certificate2 OtherRoot { get; }
    public string RootSha => Convert.ToHexString(SHA256.HashData(Root.RawData)).ToLowerInvariant();

    public TestPki()
    {
        Root = Ca("CN=Test Root CA, O=Test PKI", null);
        Intermediate = Ca("CN=Test Code Signing CA, O=Test PKI", Root);
        OtherRoot = Ca("CN=Test Root CA, O=Test PKI", null); // same name, different key
    }

    private static X509Certificate2 Ca(string subject, X509Certificate2? issuer)
    {
        var key = RSA.Create(2048);
        var req = new CertificateRequest(subject, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        req.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(req.PublicKey, false));
        if (issuer is null) return req.CreateSelfSigned(DateTimeOffset.UtcNow.AddYears(-1), DateTimeOffset.UtcNow.AddYears(10));
        using var c = req.Create(issuer, DateTimeOffset.UtcNow.AddYears(-1), DateTimeOffset.UtcNow.AddYears(5), RandomNumberGenerator.GetBytes(8));
        return c.CopyWithPrivateKey(key);
    }

    public X509Certificate2 Signer(string cn, string org, X509Certificate2? issuer = null, bool expired = false)
    {
        var key = RSA.Create(2048);
        var req = new CertificateRequest($"CN={cn}, O={org}", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.3") }, false));
        DateTimeOffset from = expired ? DateTimeOffset.UtcNow.AddMonths(-11) : DateTimeOffset.UtcNow.AddDays(-1);
        DateTimeOffset to = expired ? DateTimeOffset.UtcNow.AddDays(-1) : DateTimeOffset.UtcNow.AddYears(1);
        using var c = req.Create(issuer ?? Intermediate, from, to, RandomNumberGenerator.GetBytes(8));
        return c.CopyWithPrivateKey(key);
    }

    public TrustList Trust(params (string Cn, string Org, PackageType Type)[] publishers) => new(new TrustedPublishers
    {
        Version = 1, Roots = [new TrustedRoot { Name = "Test Root CA", Sha256 = RootSha, File = "test-root.pem" }],
        Publishers = publishers.Select(p => new TrustedPublisher { Name = p.Cn, CommonName = p.Cn, Organization = p.Org, Root = RootSha, PackageTypes = [p.Type], Reason = "test" }).ToList(),
    }, new Dictionary<string, X509Certificate2> { [RootSha] = Root });

    // ---- Catalogs ---------------------------------------------------------------------------

    /// <summary>A certificate trust list naming each file's digest.</summary>
    public static byte[] Ctl(IEnumerable<byte[]> memberDigests)
    {
        var w = new AsnWriter(AsnEncodingRules.DER);
        using (w.PushSequence())
        {
            using (w.PushSequence()) w.WriteObjectIdentifier("1.3.6.1.4.1.311.12.1.1");
            w.WriteOctetString(RandomNumberGenerator.GetBytes(16));
            w.WriteUtcTime(DateTimeOffset.UtcNow);
            using (w.PushSequence()) { w.WriteObjectIdentifier("1.3.6.1.4.1.311.12.1.2"); w.WriteNull(); }
            using (w.PushSequence())
                foreach (byte[] digest in memberDigests)
                    using (w.PushSequence())
                    {
                        w.WriteOctetString(Encoding.Unicode.GetBytes(Convert.ToHexString(digest)));
                        using (w.PushSetOf())
                        using (w.PushSequence())
                        {
                            w.WriteObjectIdentifier(SignedData.OidSpcIndirectData);
                            using (w.PushSetOf())
                            using (w.PushSequence())
                            {
                                using (w.PushSequence()) w.WriteObjectIdentifier("1.3.6.1.4.1.311.2.1.25");
                                using (w.PushSequence())
                                {
                                    using (w.PushSequence()) { w.WriteObjectIdentifier(digest.Length == 20 ? "1.3.14.3.2.26" : "2.16.840.1.101.3.4.2.1"); w.WriteNull(); }
                                    w.WriteOctetString(digest);
                                }
                            }
                        }
                    }
        }
        return w.Encode();
    }

    /// <summary>Signs content as PKCS #7 SignedData. <paramref name="cmsStyle"/> wraps it in an OCTET STRING; real catalogs carry it directly.</summary>
    public byte[] Sign(byte[] contentDer, string contentType, X509Certificate2 signer, bool cmsStyle = false, string digestOid = "2.16.840.1.101.3.4.2.1",
        Func<byte[], byte[]>? tamperAfterSigning = null, bool includeIntermediate = true)
    {
        HashAlgorithmName alg = digestOid == "1.3.14.3.2.26" ? HashAlgorithmName.SHA1 : HashAlgorithmName.SHA256;
        byte[] signedValue = cmsStyle ? contentDer : SignedData.ValueOf(contentDer);
        byte[] digest = alg == HashAlgorithmName.SHA1 ? SHA1.HashData(signedValue) : SHA256.HashData(signedValue);
        var attrs = new AsnWriter(AsnEncodingRules.DER);
        using (attrs.PushSetOf())
        {
            using (attrs.PushSequence()) { attrs.WriteObjectIdentifier("1.2.840.113549.1.9.3"); using (attrs.PushSetOf()) attrs.WriteObjectIdentifier(contentType); }
            using (attrs.PushSequence()) { attrs.WriteObjectIdentifier("1.2.840.113549.1.9.4"); using (attrs.PushSetOf()) attrs.WriteOctetString(digest); }
        }
        byte[] attrSet = attrs.Encode();
        byte[] signature;
        using (RSA key = signer.GetRSAPrivateKey()!) signature = key.SignData(attrSet, alg, RSASignaturePadding.Pkcs1);
        byte[] attrImplicit = (byte[])attrSet.Clone();
        attrImplicit[0] = 0xA0;
        byte[] content = tamperAfterSigning?.Invoke(contentDer) ?? contentDer;

        var w = new AsnWriter(AsnEncodingRules.DER);
        using (w.PushSequence())
        {
            w.WriteObjectIdentifier(SignedData.OidSignedData);
            using (w.PushSequence(new Asn1Tag(TagClass.ContextSpecific, 0)))
            using (w.PushSequence())
            {
                w.WriteInteger(1);
                using (w.PushSetOf()) using (w.PushSequence()) { w.WriteObjectIdentifier(digestOid); w.WriteNull(); }
                using (w.PushSequence())
                {
                    w.WriteObjectIdentifier(contentType);
                    using (w.PushSequence(new Asn1Tag(TagClass.ContextSpecific, 0)))
                        if (cmsStyle) w.WriteOctetString(content); else w.WriteEncodedValue(content);
                }
                using (w.PushSetOf(new Asn1Tag(TagClass.ContextSpecific, 0)))
                {
                    w.WriteEncodedValue(signer.RawData);
                    if (includeIntermediate) w.WriteEncodedValue(Intermediate.RawData);
                }
                using (w.PushSetOf())
                using (w.PushSequence())
                {
                    w.WriteInteger(1);
                    using (w.PushSequence()) { w.WriteEncodedValue(signer.IssuerName.RawData); w.WriteIntegerUnsigned(signer.SerialNumberBytes.Span); }
                    using (w.PushSequence()) { w.WriteObjectIdentifier(digestOid); w.WriteNull(); }
                    w.WriteEncodedValue(attrImplicit);
                    using (w.PushSequence()) { w.WriteObjectIdentifier("1.2.840.113549.1.1.1"); w.WriteNull(); }
                    w.WriteOctetString(signature);
                }
            }
        }
        return w.Encode();
    }

    public byte[] Catalog(X509Certificate2 signer, IEnumerable<byte[]> files, bool cmsStyle = false) =>
        Sign(Ctl(files.Select(f => DriverCatalog.Digests(f).First())), SignedData.OidCtl, signer, cmsStyle);

    /// <summary>A minimal 64-bit Windows executable: just enough headers for the Authenticode hash.</summary>
    public static byte[] Pe(string body)
    {
        byte[] b = new byte[0x200];
        b[0] = (byte)'M'; b[1] = (byte)'Z';
        BitConverter.GetBytes(0x80).CopyTo(b, 0x3C);
        "PE\0\0"u8.ToArray().CopyTo(b, 0x80);
        BitConverter.GetBytes((ushort)0x8664).CopyTo(b, 0x84);
        BitConverter.GetBytes((ushort)240).CopyTo(b, 0x94);
        BitConverter.GetBytes((ushort)0x20b).CopyTo(b, 0x98);
        return b.Concat(Encoding.ASCII.GetBytes(body)).ToArray();
    }

    public static byte[] Zip(params (string Name, byte[] Content)[] files)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, content) in files)
            {
                using Stream s = zip.CreateEntry(name).Open();
                s.Write(content);
            }
        return ms.ToArray();
    }
}

/// <summary>Windows' part, faked: its own trust check and the installers.</summary>
public sealed class FakePackagePlatform : IPackagePlatform
{
    public bool WindowsAccepts = true;
    public (X509Certificate2, X509Certificate2Collection)? MsiSignature;
    public readonly List<string> Installed = new();
    public void VerifyWithWindows(string path) { if (!WindowsAccepts) throw new PackageRefusedException("signature_invalid", "WinVerifyTrust says no."); }
    public (X509Certificate2 Signer, X509Certificate2Collection Certificates) ReadMsiSignature(string path) => MsiSignature ?? throw new PackageRefusedException("signature_invalid", "Not signed.");
    public (bool Installed, long ExitCode, bool RebootRequired) InstallDriver(IReadOnlyList<string> infs) { Installed.AddRange(infs.Select(Path.GetFileName)!); return (true, 0, false); }
    public (bool Installed, long ExitCode, bool RebootRequired) InstallMsi(string msi) { Installed.Add(Path.GetFileName(msi)); return (true, 3010, true); }
    public (bool Removed, bool RebootRequired) UninstallDriver(string name) => (name == "oem12.inf", false);
}

public class PackageTests : IDisposable
{
    private static readonly TestPki Pki = new();
    private readonly TempDir _dir = new();
    private readonly FakePackagePlatform _platform = new();
    private readonly TrustList _trust = Pki.Trust(("Scanner Vendor Inc", "Scanner Vendor", PackageType.Driver), ("Scanner Vendor Inc", "Scanner Vendor", PackageType.Msi));
    private readonly X509Certificate2 _vendor = Pki.Signer("Scanner Vendor Inc", "Scanner Vendor");
    private const string Inf = "[Version]\r\nSignature=\"$WINDOWS NT$\"\r\nClass=Biometric ; the scanner\r\nCatalogFile = scanner.cat\r\n\r\n[Manufacturer]\r\n";
    private static readonly byte[] Sys = TestPki.Pe("scanner driver code");

    public void Dispose() => _dir.Dispose();

    private PackageInstaller Installer() => new(_dir.File("downloads"), _dir.File("staging"), _trust, _platform, _ => { });

    private (Guid Id, string Sha) Download(byte[] package)
    {
        Guid id = Guid.NewGuid();
        Directory.CreateDirectory(_dir.File("downloads"));
        File.WriteAllBytes(PackageInstaller.DownloadPath(_dir.File("downloads"), id), package);
        return (id, Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant());
    }

    private PackageInstallOutput Install(byte[] package, PackageType type = PackageType.Driver, string? sha = null)
    {
        var (id, actual) = Download(package);
        return OperationContext.RunAsync<PackageInstallOutput>(Guid.NewGuid(), () => Task.FromResult(
            Installer().Install(new PackageInstallParams { PackageId = id, PackageType = type, Sha256 = sha ?? actual }))).GetAwaiter().GetResult();
    }

    private string Refusal(byte[] package, PackageType type = PackageType.Driver, string? sha = null)
    {
        var e = Assert.Throws<OperationFailedException>(() => Install(package, type, sha));
        Assert.Empty(Directory.Exists(_dir.File("staging")) ? Directory.EnumerateFileSystemEntries(_dir.File("staging")) : []); // staging emptied either way
        Assert.Empty(_platform.Installed); // nothing installed
        return e.Code;
    }

    private byte[] GoodDriver(bool cmsStyle = false) => TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("x64/scanner.sys", Sys),
        ("scanner.cat", Pki.Catalog(_vendor, [Encoding.ASCII.GetBytes(Inf), Sys], cmsStyle)));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_signed_driver_package_from_a_trusted_publisher_installs_and_staging_is_emptied(bool cmsStyle)
    {
        var output = Install(GoodDriver(cmsStyle));
        Assert.True(output.Installed);
        Assert.Equal("Scanner Vendor Inc", output.Signer);
        Assert.Equal(new PackageChecks { Hash = CheckOutcome.Passed, Signature = CheckOutcome.Passed, Publisher = CheckOutcome.Passed }, output.Checks);
        Assert.Equal(["scanner.inf"], _platform.Installed);
        Assert.Empty(Directory.EnumerateFileSystemEntries(_dir.File("staging")));
        // The broker only reads the download; the network service removes it (SYSTEM never deletes through a folder it does not own).
        Assert.Single(Directory.EnumerateFiles(_dir.File("downloads")));
    }

    [Fact]
    public void A_package_whose_hash_is_not_the_approved_one_is_refused_first()
    {
        Assert.Equal("hash_mismatch", Refusal(GoodDriver(), sha: new string('0', 64)));
    }

    [Fact]
    public void A_tampered_driver_file_is_refused()
    {
        byte[] tampered = Sys.Concat("evil"u8.ToArray()).ToArray();
        byte[] zip = TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("x64/scanner.sys", tampered),
            ("scanner.cat", Pki.Catalog(_vendor, [Encoding.ASCII.GetBytes(Inf), Sys])));
        Assert.Equal("signature_invalid", Refusal(zip));
    }

    [Fact]
    public void Changing_only_the_executable_checksum_does_not_break_its_authenticode_hash()
    {
        byte[] other = (byte[])Sys.Clone();
        other[0x98 + 64] = 0x42; // the PE checksum field
        Assert.Equal(DriverCatalog.Digests(Sys).First(), DriverCatalog.Digests(other).First());
        Assert.NotEqual(DriverCatalog.Digests(Sys).Last(), DriverCatalog.Digests(other).Last()); // the plain hash differs
    }

    [Fact]
    public void An_extra_file_the_catalog_does_not_list_is_refused()
    {
        byte[] zip = TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("x64/scanner.sys", Sys), ("helper.dll", TestPki.Pe("extra")),
            ("scanner.cat", Pki.Catalog(_vendor, [Encoding.ASCII.GetBytes(Inf), Sys])));
        Assert.Equal("signature_invalid", Refusal(zip));
    }

    [Fact]
    public void An_unsigned_package_is_refused()
    {
        Assert.Equal("signature_invalid", Refusal(TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes("[Version]\r\nSignature=\"$WINDOWS NT$\"\r\n")), ("scanner.sys", Sys))));
        Assert.Equal("signature_invalid", Refusal(TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("scanner.sys", Sys)))); // names a catalog that is missing
        Assert.Equal("verification_failed", Refusal(TestPki.Zip(("scanner.sys", Sys)))); // no INF at all
    }

    [Fact]
    public void A_catalog_changed_after_signing_is_refused()
    {
        byte[] evilCtl = TestPki.Ctl([DriverCatalog.Digests(Encoding.ASCII.GetBytes(Inf)).First(), DriverCatalog.Digests(TestPki.Pe("evil")).First()]);
        byte[] cat = Pki.Sign(TestPki.Ctl([DriverCatalog.Digests(Encoding.ASCII.GetBytes(Inf)).First(), DriverCatalog.Digests(Sys).First()]), SignedData.OidCtl, _vendor,
            tamperAfterSigning: _ => evilCtl);
        byte[] zip = TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("scanner.sys", TestPki.Pe("evil")), ("scanner.cat", cat));
        Assert.Equal("signature_invalid", Refusal(zip));
    }

    [Fact]
    public void A_signer_not_on_the_list_is_refused_even_under_a_trusted_root()
    {
        var other = Pki.Signer("Some Other Company", "Scanner Vendor");
        byte[] zip = TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("scanner.sys", Sys), ("scanner.cat", Pki.Catalog(other, [Encoding.ASCII.GetBytes(Inf), Sys])));
        Assert.Equal("publisher_not_trusted", Refusal(zip));
    }

    [Fact]
    public void A_trusted_name_from_another_root_is_refused()
    {
        var rogueIntermediate = Pki.OtherRoot; // same subject names, different keys
        var impostor = Pki.Signer("Scanner Vendor Inc", "Scanner Vendor", issuer: rogueIntermediate);
        byte[] cat = Pki.Sign(TestPki.Ctl([DriverCatalog.Digests(Encoding.ASCII.GetBytes(Inf)).First(), DriverCatalog.Digests(Sys).First()]), SignedData.OidCtl, impostor, includeIntermediate: false);
        byte[] zip = TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("scanner.sys", Sys), ("scanner.cat", cat));
        Assert.Equal("publisher_not_trusted", Refusal(zip));
    }

    [Fact]
    public void A_driver_publisher_is_not_trusted_for_installers_and_the_reverse()
    {
        var driverOnly = Pki.Trust(("Scanner Vendor Inc", "Scanner Vendor", PackageType.Driver));
        Assert.Null(driverOnly.Match(_vendor, [Pki.Intermediate], PackageType.Msi));
        Assert.NotNull(driverOnly.Match(_vendor, [Pki.Intermediate], PackageType.Driver));
    }

    [Fact]
    public void An_expired_signing_certificate_is_left_to_windows_timestamp_check()
    {
        var old = Pki.Signer("Scanner Vendor Inc", "Scanner Vendor", expired: true);
        Assert.NotNull(_trust.Match(old, [Pki.Intermediate], PackageType.Driver));
    }

    [Fact]
    public void Sha1_signatures_are_not_accepted()
    {
        byte[] cat = Pki.Sign(TestPki.Ctl([DriverCatalog.Digests(Sys).First()]), SignedData.OidCtl, _vendor, digestOid: "1.3.14.3.2.26");
        Assert.Equal("signature_invalid", Assert.Throws<PackageRefusedException>(() => DriverCatalog.Parse(cat)).Code);
    }

    [Fact]
    public void Windows_own_check_has_the_last_word()
    {
        _platform.WindowsAccepts = false;
        Assert.Equal("signature_invalid", Refusal(GoodDriver()));
    }

    [Theory]
    [InlineData("../evil.dll")]
    [InlineData("x64/../../evil.dll")]
    [InlineData("C:/Windows/System32/evil.dll")]
    [InlineData("/etc/passwd")]
    [InlineData("CON.inf")]
    [InlineData("a/aux.sys")]
    [InlineData("name.")]
    [InlineData("tab\there.inf")]
    public void Hostile_file_names_are_refused(string name)
    {
        Assert.False(DriverPackage.SafeName(name));
        Assert.Equal("verification_failed", Refusal(TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), (name, Sys))));
    }

    [Fact]
    public void The_same_file_twice_or_a_zip_bomb_is_refused()
    {
        Assert.Equal("verification_failed", Refusal(TestPki.Zip(("scanner.inf", Encoding.ASCII.GetBytes(Inf)), ("SCANNER.INF", Encoding.ASCII.GetBytes(Inf)))));
        string zip = _dir.File("bomb.zip");
        File.WriteAllBytes(zip, TestPki.Zip(("big.bin", new byte[2_000_000])));
        Assert.Equal("verification_failed", Assert.Throws<PackageRefusedException>(() => DriverPackage.Extract(zip, _dir.File("out"), maxEntryBytes: 1_000_000)).Code);
        File.WriteAllBytes(zip, "PK\u0003\u0004 this is not a zip"u8.ToArray());
        Assert.Equal("verification_failed", Assert.Throws<PackageRefusedException>(() => DriverPackage.Extract(zip, _dir.File("out2"))).Code);
    }

    [Fact]
    public void Garbage_where_a_catalog_should_be_is_refused_cleanly()
    {
        foreach (byte[] junk in new[] { Array.Empty<byte>(), "not der"u8.ToArray(), RandomNumberGenerator.GetBytes(4096), new byte[] { 0x30, 0x84, 0xFF, 0xFF, 0xFF, 0xFF } })
            Assert.Equal("signature_invalid", Assert.Throws<PackageRefusedException>(() => DriverCatalog.Parse(junk)).Code);
    }

    [Fact]
    public void Inf_catalog_names_are_read_from_the_version_section_only()
    {
        Assert.Equal(["scanner.cat"], DriverPackage.CatalogFilesOf(Encoding.ASCII.GetBytes(Inf)));
        string inf = "; CatalogFile=commented.cat\r\n[Strings]\r\nCatalogFile=wrong.cat\r\n[version]\r\nCatalogFile.NTamd64 = \"x64.cat\" ; amd64\r\n";
        Assert.Equal(["x64.cat"], DriverPackage.CatalogFilesOf(Encoding.ASCII.GetBytes(inf)));
        byte[] utf16 = new byte[] { 0xFF, 0xFE }.Concat(Encoding.Unicode.GetBytes("[Version]\r\nCatalogFile=u.cat\r\n")).ToArray();
        Assert.Equal(["u.cat"], DriverPackage.CatalogFilesOf(utf16));
    }

    [Fact]
    public void An_msi_is_checked_by_windows_then_its_signer_against_the_list()
    {
        _platform.MsiSignature = (_vendor, new X509Certificate2Collection { Pki.Intermediate });
        var ok = Install("msi bytes"u8.ToArray(), PackageType.Msi);
        Assert.True(ok.RebootRequired);
        Assert.Equal(3010, ok.ExitCode);
        _platform.Installed.Clear();
        _platform.MsiSignature = (Pki.Signer("Evil Corp", "Evil"), new X509Certificate2Collection { Pki.Intermediate });
        Assert.Equal("publisher_not_trusted", Refusal("msi bytes"u8.ToArray(), PackageType.Msi));
        _platform.MsiSignature = null;
        Assert.Equal("signature_invalid", Refusal("msi bytes"u8.ToArray(), PackageType.Msi));
    }

    [Fact]
    public async Task Refusals_come_back_to_the_server_as_rejections()
    {
        var (id, _) = Download(GoodDriver());
        var registry = Installer().Register(new OperationRegistry());
        var processorRegistry = registry;
        var config = Fixtures.Config();
        var clock = new ManualClock(DateTimeOffset.UtcNow);
        var processor = new CommandProcessor(new CommandValidator(config, new ReplayStore(null, clock), new RateLimiter(null, clock), clock), processorRegistry, clock);
        var command = Fixtures.Command("package.install", new JsonObject { ["packageId"] = id.ToString(), ["packageType"] = "driver", ["sha256"] = new string('a', 64) }, issued: clock.GetUtcNow());
        var (result, _) = await processor.ProcessAsync(Fixtures.Bytes(command), default);
        Assert.Equal(ResultStatus.Rejected, result!.Status);
        Assert.Equal("hash_mismatch", result.Error!.Code);
    }

    [Fact]
    public void The_compiled_in_list_is_microsoft_only_until_the_scanner_vendor_is_added()
    {
        var list = TrustList.Compiled.List;
        Assert.All(list.Publishers, p => Assert.Equal("Microsoft Corporation", p.Organization));
        Assert.Contains(list.Publishers, p => p.CommonName == "Microsoft Windows Hardware Compatibility Publisher" && p.PackageTypes.Contains(PackageType.Driver));
    }

    [Fact]
    public void Driver_uninstall_names_one_oem_driver()
    {
        var u = Installer();
        Assert.True(u.Uninstall(new DriverUninstallParams { PublishedName = "OEM12.INF" }).Removed);
        Assert.Equal("not_found", Assert.Throws<OperationFailedException>(() => u.Uninstall(new DriverUninstallParams { PublishedName = "oem99.inf" })).Code);
    }
}

public class DriverClassTests
{
    [Theory]
    [InlineData("[Version]\r\nClass=System\r\nCatalogFile=x.cat\r\n", "System")]
    [InlineData("[Version]\r\nClass = SoftwareComponent\r\nCatalogFile=x.cat\r\n", "SoftwareComponent")]
    [InlineData("[Version]\r\nCatalogFile=x.cat\r\n", null)]
    [InlineData("[Strings]\r\nClass=Biometric\r\n[Version]\r\nCatalogFile=x.cat\r\n", null)] // Class outside [Version] does not count
    [InlineData("[Version]\r\nClass=\"Biometric\" ; scanner\r\n", "Biometric")]
    public void Reads_the_class_from_the_version_section_only(string inf, string? expected) =>
        Assert.Equal(expected, DriverPackage.ClassOf(System.Text.Encoding.ASCII.GetBytes(inf)));

    [Fact]
    public void Kernel_and_unclassified_drivers_are_not_allowed_peripherals_and_storage_are()
    {
        foreach (string c in new[] { "System", "SoftwareComponent", "LegacyDriver", "Unknown", "" }) Assert.DoesNotContain(c, DriverPackage.AllowedClasses);
        foreach (string c in new[] { "Biometric", "USB", "Net", "SCSIAdapter", "hidclass" }) Assert.Contains(c, DriverPackage.AllowedClasses);
    }
}
