using System.IO.Compression;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Core.Upgrades;

namespace Cabinet.Agent.Core.Tests;

/// <summary>
/// Stands in for WinVerifyTrust on Linux: a test binary says in its own bytes whether it is signed and by whom
/// ("MZ|signed:Agent Publisher"), unsigned ("MZ|unsigned") or changed after signing ("MZ|tampered:...").
/// The publisher match and chain check are the real ones.
/// </summary>
public sealed class FakeAuthenticode(Dictionary<string, X509Certificate2> signers, X509Certificate2Collection chain) : IAuthenticode
{
    public int Verify(string path)
    {
        string text = File.ReadAllText(path);
        if (text.Contains("|unsigned")) return unchecked((int)0x800B0100); // TRUST_E_NOSIGNATURE
        if (text.Contains("|tampered")) return unchecked((int)0x80096010); // TRUST_E_BAD_DIGEST
        return 0;
    }

    public (X509Certificate2 Signer, X509Certificate2Collection Certificates)? ReadSignature(string path)
    {
        string text = File.ReadAllText(path);
        int at = text.IndexOf("|signed:", StringComparison.Ordinal);
        if (at < 0) return null;
        return (signers[text[(at + 8)..].Trim()], chain);
    }
}

/// <summary>A release key, a code-signing publisher under a test root, and releases built and signed the way the pipeline does.</summary>
public sealed class ReleaseFixture : IDisposable
{
    public string Dir { get; } = Directory.CreateTempSubdirectory("upgrade-").FullName;
    public ECDsa Key { get; } = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    public ECDsa NextKey { get; } = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    public TestPki Pki { get; } = new();
    public UpgradeTrust Trust { get; }
    public FakeAuthenticode Authenticode { get; }
    public string Downloads => Path.Combine(Dir, "downloads");
    public string Staging => Path.Combine(Dir, "staging");

    public static string KeyId(ECDsa key) => Convert.ToHexString(SHA256.HashData(key.ExportSubjectPublicKeyInfo())).ToLowerInvariant();

    public ReleaseFixture(bool withPublisher = true, bool withKeys = true)
    {
        Trust = MakeTrust(withPublisher, withKeys ? [Key] : []);
        Authenticode = new FakeAuthenticode(new()
        {
            ["Agent Publisher"] = Pki.Signer("Mashura Agent Code Signing", "Mashura"),
            ["Impostor"] = Pki.Signer("Mashura Agent Code Signing", "Mashura", Pki.OtherRoot),
            ["Scanner Vendor"] = Pki.Signer("Scanner Vendor Inc", "Scanner Vendor"),
        }, new X509Certificate2Collection { Pki.Intermediate });
    }

    public UpgradeTrust MakeTrust(bool withPublisher, ECDsa[] keys) => new(new UpgradeKeys
    {
        Version = 1,
        Keys = keys.Select((k, i) => new UpgradeKey { KeyId = KeyId(k), Name = $"key {i}", PublicKey = Convert.ToBase64String(k.ExportSubjectPublicKeyInfo()) }).ToList(),
        Publishers = withPublisher ? [new UpgradePublisher { CommonName = "Mashura Agent Code Signing", Organization = "Mashura", Root = Pki.RootSha, RootFile = "root.pem" }] : [],
    }, new Dictionary<string, X509Certificate2> { ["root.pem"] = Pki.Root });

    public static Dictionary<string, string> Programs(string signedBy = "Agent Publisher") => new()
    {
        ["Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe"] = $"MZ|signed:{signedBy}",
        ["Cabinet.Agent.Network/Cabinet.Agent.Network.exe"] = $"MZ|signed:{signedBy}",
        ["Cabinet.Agent.Updater/Cabinet.Agent.Updater.exe"] = $"MZ|signed:{signedBy}",
        ["Cabinet.Agent.Harness/cabinet-harness.exe"] = $"MZ|signed:{signedBy}",
        ["Cabinet.Agent.Network/appsettings.json"] = "{}",
    };

    public static byte[] Zip(Dictionary<string, string> files)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
            foreach (var (name, content) in files)
                using (var w = new StreamWriter(zip.CreateEntry(name).Open())) w.Write(content);
        return ms.ToArray();
    }

    public static byte[] ManifestBytes(UpgradeManifest m) => JsonSerializer.SerializeToUtf8Bytes(m, ContractJson.Options);

    public static UpgradeManifest Manifest(string version, byte[] zip, string minimum = "0.1.0") => new()
    {
        Product = UpgradeTrust.Product, Version = version, MinimumVersion = minimum, Sha256 = Convert.ToHexString(SHA256.HashData(zip)).ToLowerInvariant(),
        SizeBytes = zip.Length, ReleasedAt = DateTimeOffset.UtcNow,
    };

    public UpgradeSignature Sign(byte[] manifest, ECDsa? key = null) => new()
    {
        KeyId = KeyId(key ?? Key), Algorithm = UpgradeTrust.Algorithm,
        Signature = Convert.ToBase64String((key ?? Key).SignData(manifest, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence)),
    };

    /// <summary>Places a release in the downloads folder as the network service would.</summary>
    public void Place(string version, byte[] manifest, UpgradeSignature signature, byte[] zip)
    {
        string folder = ReleaseVerifier.DownloadFolder(Downloads, version);
        if (Directory.Exists(folder)) Directory.Delete(folder, true);
        Directory.CreateDirectory(folder);
        File.WriteAllBytes(Path.Combine(folder, ReleaseVerifier.ManifestFile), manifest);
        File.WriteAllBytes(Path.Combine(folder, ReleaseVerifier.SignatureFile), JsonSerializer.SerializeToUtf8Bytes(signature, ContractJson.Options));
        File.WriteAllBytes(Path.Combine(folder, ReleaseVerifier.PackageFile), zip);
    }

    public void PlaceGood(string version, Dictionary<string, string>? files = null, string minimum = "0.1.0")
    {
        byte[] zip = Zip(files ?? Programs());
        byte[] manifest = ManifestBytes(Manifest(version, zip, minimum));
        Place(version, manifest, Sign(manifest), zip);
    }

    public ReleaseVerifier Verifier() => new(Trust, Authenticode);

    public void Dispose()
    {
        Key.Dispose(); NextKey.Dispose(); Trust.Dispose();
        try { Directory.Delete(Dir, true); } catch (IOException) { }
    }
}

public class SemVersionTests
{
    [Theory]
    [InlineData("0.1.0", "0.1.1")]
    [InlineData("0.9.9", "0.10.0")]
    [InlineData("1.0.0-rc.1", "1.0.0")]
    [InlineData("1.0.0-alpha", "1.0.0-alpha.1")]
    [InlineData("1.0.0-alpha.2", "1.0.0-alpha.10")]
    [InlineData("1.0.0-alpha.1", "1.0.0-beta")]
    [InlineData("2.0.0", "10.0.0")]
    public void Orders_versions_by_semantic_versioning(string older, string newer)
    {
        Assert.True(SemVersion.Parse(older) < SemVersion.Parse(newer));
        Assert.True(SemVersion.Parse(newer) > SemVersion.Parse(older));
        Assert.Equal(newer, SemVersion.Parse(newer).ToString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("1.0")]
    [InlineData("1.0.0.0")]
    [InlineData("01.0.0")]
    [InlineData("1.0.0-")]
    [InlineData("-1.0.0")]
    [InlineData("1.0.0+build")]
    [InlineData("1.0.0-a..b")]
    [InlineData("1.0.0-ä")]
    [InlineData("9999999999.0.0")]
    [InlineData("..\\..\\x")]
    [InlineData("1.0.0-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void Refuses_anything_that_is_not_an_agent_version(string text) => Assert.False(SemVersion.TryParse(text, out _));
}

public class UpgradeTrustTests
{
    [Fact]
    public void The_compiled_in_file_holds_the_provisioned_release_key_and_refuses_others()
    {
        // contracts/trust/upgrade/upgrade-keys.json holds the operator's release key: the public half only, P-256, which
        // Load checks as it reads it. A build with no keys would accept no upgrade at all; this build accepts exactly the
        // releases signed by this key, and names any other key it does not hold rather than pretending it holds none.
        UpgradeTrust t = UpgradeTrust.Compiled;
        Assert.True(t.HasKeys);
        UpgradeKey key = Assert.Single(t.List.Keys);
        Assert.Equal(64, key.KeyId.Length);
        using ECDsa publicKey = ECDsa.Create();
        publicKey.ImportSubjectPublicKeyInfo(Convert.FromBase64String(key.PublicKey), out _);
        Assert.Equal(256, publicKey.KeySize);
        Assert.False(t.VerifyManifest("{}"u8, new UpgradeSignature { KeyId = new string('a', 64), Algorithm = UpgradeTrust.Algorithm, Signature = "AAAA" }, out string why));
        Assert.Contains("does not hold", why);
    }

    [Fact]
    public void A_signature_verifies_only_over_the_exact_bytes_with_a_held_key()
    {
        using var f = new ReleaseFixture();
        byte[] manifest = Encoding.UTF8.GetBytes("{\"version\":\"1.0.0\"}");
        Assert.True(f.Trust.VerifyManifest(manifest, f.Sign(manifest), out _));
        byte[] changed = (byte[])manifest.Clone(); changed[^3] ^= 1;
        Assert.False(f.Trust.VerifyManifest(changed, f.Sign(manifest), out _));
        Assert.False(f.Trust.VerifyManifest(manifest, f.Sign(manifest, f.NextKey), out string unknown));
        Assert.Contains("does not hold", unknown);
        Assert.False(f.Trust.VerifyManifest(manifest, f.Sign(manifest) with { Algorithm = "rsa-pkcs1-sha256" }, out _));
        Assert.False(f.Trust.VerifyManifest(manifest, f.Sign(manifest) with { Signature = "not base64!" }, out _));
        Assert.False(f.Trust.VerifyManifest(manifest, f.Sign(manifest) with { Signature = Convert.ToBase64String(new byte[64]) }, out _));
        // A key claimed under another key's ID does not help.
        Assert.False(f.Trust.VerifyManifest(manifest, f.Sign(manifest, f.NextKey) with { KeyId = ReleaseFixture.KeyId(f.Key) }, out _));
    }

    [Fact]
    public void A_second_future_key_is_accepted_alongside_the_current_one()
    {
        using var f = new ReleaseFixture();
        using UpgradeTrust both = f.MakeTrust(true, [f.Key, f.NextKey]);
        byte[] manifest = "{}"u8.ToArray();
        Assert.True(both.VerifyManifest(manifest, f.Sign(manifest, f.Key), out _));
        Assert.True(both.VerifyManifest(manifest, f.Sign(manifest, f.NextKey), out _));
    }

    [Fact]
    public void A_key_file_that_lies_about_its_keys_or_root_is_refused()
    {
        using var f = new ReleaseFixture();
        string spki = Convert.ToBase64String(f.Key.ExportSubjectPublicKeyInfo());
        Assert.Throws<InvalidOperationException>(() => new UpgradeTrust(new UpgradeKeys
        {
            Version = 1, Keys = [new UpgradeKey { KeyId = new string('0', 64), Name = "wrong id", PublicKey = spki }], Publishers = [],
        }, new Dictionary<string, X509Certificate2>()));
        using var p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        Assert.Throws<InvalidOperationException>(() => new UpgradeTrust(new UpgradeKeys
        {
            Version = 1, Keys = [new UpgradeKey { KeyId = ReleaseFixture.KeyId(p384), Name = "P-384", PublicKey = Convert.ToBase64String(p384.ExportSubjectPublicKeyInfo()) }], Publishers = [],
        }, new Dictionary<string, X509Certificate2>()));
        Assert.Throws<InvalidOperationException>(() => new UpgradeTrust(new UpgradeKeys
        {
            Version = 1, Keys = [], Publishers = [new UpgradePublisher { CommonName = "x", Organization = "y", Root = f.Pki.RootSha, RootFile = "root.pem" }],
        }, new Dictionary<string, X509Certificate2> { ["root.pem"] = f.Pki.OtherRoot }));
    }

    [Fact]
    public void Only_the_agent_publisher_under_its_pinned_root_matches()
    {
        using var f = new ReleaseFixture();
        var chain = new X509Certificate2Collection { f.Pki.Intermediate };
        Assert.Equal("Mashura Agent Code Signing", f.Trust.MatchPublisher(f.Pki.Signer("Mashura Agent Code Signing", "Mashura"), chain));
        Assert.Null(f.Trust.MatchPublisher(f.Pki.Signer("Mashura Agent Code Signing", "Mashura", f.Pki.OtherRoot), chain));
        Assert.Null(f.Trust.MatchPublisher(f.Pki.Signer("Mashura Agent Code Signing", "Mashura Ltd"), chain));
        Assert.Null(f.Trust.MatchPublisher(f.Pki.Signer("Scanner Vendor Inc", "Scanner Vendor"), chain));
    }
}

public class ReleaseVerifierTests : IDisposable
{
    private readonly ReleaseFixture _f = new();
    public void Dispose() => _f.Dispose();

    private UpgradeRefusedException Refused(string version = "0.2.0", string running = "0.1.0") =>
        Assert.Throws<UpgradeRefusedException>(() => _f.Verifier().Verify(_f.Downloads, version, running, _f.Staging));

    private void AssertStagingEmpty() => Assert.Empty(Directory.EnumerateFileSystemEntries(_f.Staging));

    [Fact]
    public void A_good_release_passes_every_check_and_is_staged()
    {
        _f.PlaceGood("0.2.0");
        VerifiedRelease r = _f.Verifier().Verify(_f.Downloads, "0.2.0", "0.1.0", _f.Staging);
        Assert.Equal("0.2.0", r.Manifest.Version);
        Assert.True(File.Exists(Path.Combine(r.Files, "Cabinet.Agent.Broker", "Cabinet.Agent.Broker.exe")));
        Assert.False(File.Exists(Path.Combine(_f.Staging, ReleaseVerifier.PackageFile)));
    }

    [Fact]
    public void A_bad_signature_is_refused_first_even_when_everything_else_is_also_wrong()
    {
        byte[] zip = ReleaseFixture.Zip(ReleaseFixture.Programs("Impostor"));
        byte[] manifest = ReleaseFixture.ManifestBytes(ReleaseFixture.Manifest("0.0.1", zip) with { Sha256 = new string('0', 64) });
        _f.Place("0.2.0", manifest, _f.Sign(manifest, _f.NextKey), zip);
        var e = Refused();
        Assert.Equal(UpgradeCheck.ManifestSignature, e.Check);
        Assert.Equal("signature_invalid", e.Code);
        AssertStagingEmpty();
    }

    [Fact]
    public void A_manifest_changed_after_signing_is_refused()
    {
        byte[] zip = ReleaseFixture.Zip(ReleaseFixture.Programs());
        byte[] manifest = ReleaseFixture.ManifestBytes(ReleaseFixture.Manifest("0.2.0", zip));
        UpgradeSignature sig = _f.Sign(manifest);
        byte[] changed = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(manifest).Replace("0.1.0", "0.0.0"));
        _f.Place("0.2.0", changed, sig, zip);
        Assert.Equal(UpgradeCheck.ManifestSignature, Refused().Check);
    }

    [Fact]
    public void A_tampered_package_is_refused_on_its_hash()
    {
        byte[] zip = ReleaseFixture.Zip(ReleaseFixture.Programs());
        byte[] manifest = ReleaseFixture.ManifestBytes(ReleaseFixture.Manifest("0.2.0", zip));
        byte[] tampered = (byte[])zip.Clone(); tampered[tampered.Length / 2] ^= 0xFF;
        _f.Place("0.2.0", manifest, _f.Sign(manifest), tampered);
        var e = Refused();
        Assert.Equal(UpgradeCheck.PackageHash, e.Check);
        Assert.Equal("hash_mismatch", e.Code);
        AssertStagingEmpty();
        // A whole other package of the same size is refused too.
        byte[] other = ReleaseFixture.Zip(ReleaseFixture.Programs().ToDictionary(kv => kv.Key, kv => kv.Value.Replace("Agent Publisher", "Agent Publishes")));
        _f.Place("0.2.0", manifest, _f.Sign(manifest), other);
        Assert.Equal(UpgradeCheck.PackageHash, Refused().Check);
    }

    [Theory]
    [InlineData("0.2.0", "0.2.0")]
    [InlineData("0.2.0", "0.3.0")]
    [InlineData("0.2.0-rc.1", "0.2.0")]
    public void Never_a_downgrade_or_the_same_version(string offered, string running)
    {
        _f.PlaceGood(offered);
        var e = Refused(offered, running);
        Assert.Equal(UpgradeCheck.Version, e.Check);
        Assert.Contains("never downgrade", e.Message);
    }

    [Fact]
    public void Not_from_a_version_older_than_the_release_minimum()
    {
        _f.PlaceGood("0.5.0", minimum: "0.4.0");
        var e = Refused("0.5.0", "0.3.9");
        Assert.Equal(UpgradeCheck.Version, e.Check);
        Assert.Contains("0.4.0", e.Message);
    }

    [Fact]
    public void A_manifest_for_another_version_or_product_is_refused_even_when_signed()
    {
        byte[] zip = ReleaseFixture.Zip(ReleaseFixture.Programs());
        byte[] manifest = ReleaseFixture.ManifestBytes(ReleaseFixture.Manifest("0.3.0", zip));
        _f.Place("0.2.0", manifest, _f.Sign(manifest), zip);
        Assert.Equal(UpgradeCheck.Manifest, Refused().Check);
        byte[] other = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(ReleaseFixture.ManifestBytes(ReleaseFixture.Manifest("0.2.0", zip))).Replace(UpgradeTrust.Product, "other-product"));
        _f.Place("0.2.0", other, _f.Sign(other), zip);
        Assert.Equal(UpgradeCheck.Manifest, Refused().Check);
        byte[] extra = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(ReleaseFixture.ManifestBytes(ReleaseFixture.Manifest("0.2.0", zip))).TrimEnd('}') + ",\"postInstall\":\"cmd /c calc\"}");
        _f.Place("0.2.0", extra, _f.Sign(extra), zip);
        Assert.Equal(UpgradeCheck.Manifest, Refused().Check);
    }

    [Theory]
    [InlineData("Cabinet.Agent.Network/Cabinet.Agent.Network.exe", "MZ|unsigned", "signature_invalid")]
    [InlineData("Cabinet.Agent.Network/Cabinet.Agent.Network.exe", "MZ|tampered:Agent Publisher", "signature_invalid")]
    [InlineData("Cabinet.Agent.Network/Cabinet.Agent.Network.exe", "MZ|signed:Impostor", "publisher_not_trusted")]
    [InlineData("Cabinet.Agent.Network/Cabinet.Agent.Network.exe", "MZ|signed:Scanner Vendor", "publisher_not_trusted")]
    [InlineData("Cabinet.Agent.Network/extra.dll", "MZ|unsigned", "signature_invalid")]
    [InlineData("Cabinet.Agent.Network/readme.txt", "MZ|unsigned", "signature_invalid")] // a binary under another name
    public void Every_binary_must_carry_the_agent_publisher_signature(string file, string content, string code)
    {
        var files = ReleaseFixture.Programs();
        files[file] = content;
        _f.PlaceGood("0.2.0", files);
        var e = Refused();
        Assert.Equal(UpgradeCheck.Authenticode, e.Check);
        Assert.Equal(code, e.Code);
        Assert.Contains(file.Split('/')[^1], e.Message);
        AssertStagingEmpty();
    }

    [Fact]
    public void A_release_without_the_services_or_the_updater_is_refused()
    {
        var files = ReleaseFixture.Programs();
        files.Remove("Cabinet.Agent.Updater/Cabinet.Agent.Updater.exe");
        _f.PlaceGood("0.2.0", files);
        Assert.Equal(UpgradeCheck.Install, Refused().Check);
    }

    [Fact]
    public void A_build_without_keys_or_publisher_accepts_nothing()
    {
        using var noKeys = new ReleaseFixture(withKeys: false);
        noKeys.PlaceGood("0.2.0");
        Assert.Equal(UpgradeCheck.ManifestSignature, Assert.Throws<UpgradeRefusedException>(() => noKeys.Verifier().Verify(noKeys.Downloads, "0.2.0", "0.1.0", noKeys.Staging)).Check);
        using var noPublisher = new ReleaseFixture(withPublisher: false);
        noPublisher.PlaceGood("0.2.0");
        Assert.Equal(UpgradeCheck.Authenticode, Assert.Throws<UpgradeRefusedException>(() => noPublisher.Verifier().Verify(noPublisher.Downloads, "0.2.0", "0.1.0", noPublisher.Staging)).Check);
    }

    [Theory]
    [InlineData("../evil.exe")]
    [InlineData("Cabinet.Agent.Broker/../../evil.exe")]
    [InlineData("C:/Windows/System32/evil.dll")]
    public void A_package_that_writes_outside_its_folder_is_refused(string name)
    {
        var files = ReleaseFixture.Programs();
        files[name] = "MZ|signed:Agent Publisher";
        _f.PlaceGood("0.2.0", files);
        var e = Refused();
        Assert.Equal("verification_failed", e.Code);
        Assert.False(File.Exists(Path.Combine(_f.Dir, "evil.exe")));
    }

    [Fact]
    public void Hostile_and_missing_files_are_refused_without_reading_further()
    {
        string folder = ReleaseVerifier.DownloadFolder(_f.Downloads, "0.2.0");
        Assert.Equal(UpgradeCheck.Download, Refused().Check); // nothing downloaded
        _f.PlaceGood("0.2.0");
        File.WriteAllBytes(Path.Combine(folder, ReleaseVerifier.SignatureFile), new byte[5000]);
        Assert.Equal(UpgradeCheck.ManifestSignature, Refused().Check);
        File.WriteAllText(Path.Combine(folder, ReleaseVerifier.SignatureFile), "{\"keyId\":\"" + new string('a', 64) + "\",\"algorithm\":\"ecdsa-p256-sha256\",\"signature\":\"AAAA\",\"path\":\"C:/x\"}");
        Assert.Equal(UpgradeCheck.ManifestSignature, Refused().Check);
        File.WriteAllText(Path.Combine(folder, ReleaseVerifier.SignatureFile), "{\"keyId\":");
        Assert.Equal(UpgradeCheck.ManifestSignature, Refused().Check);
        _f.PlaceGood("0.2.0");
        File.WriteAllBytes(Path.Combine(folder, ReleaseVerifier.ManifestFile), new byte[ReleaseVerifier.MaxManifestBytes + 1]);
        Assert.Equal(UpgradeCheck.ManifestSignature, Refused().Check);
        _f.PlaceGood("0.2.0");
        File.Delete(Path.Combine(folder, ReleaseVerifier.PackageFile));
        Assert.Equal(UpgradeCheck.Download, Refused().Check);
        Assert.Equal(UpgradeCheck.Version, Refused("..\\..\\Windows").Check);
        Assert.Equal(UpgradeCheck.Version, Refused("0.2.0", "garbage").Check);
    }
}

public sealed class FakeUpdaterPlatform(string checkIn, Func<string?> newVersionChecksInAs) : IUpdaterPlatform
{
    public List<string> Calls { get; } = [];
    public bool FailStop { get; set; }
    public void StopServices()
    {
        Calls.Add("stop");
        if (FailStop) throw new InvalidOperationException("stuck");
    }
    public void StartServices()
    {
        Calls.Add("start");
        if (newVersionChecksInAs() is { } v) CheckInFile.Write(checkIn, v, DateTimeOffset.UtcNow);
    }
}

public class UpdaterTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("updater-").FullName;
    private readonly UpdaterPaths _paths;
    private readonly UpgradeJournalStore _journal;
    private readonly List<string> _log = [];

    public UpdaterTests()
    {
        _paths = new UpdaterPaths(Path.Combine(_dir, "CabinetAgent"), Path.Combine(_dir, "CabinetAgent.previous"), Path.Combine(_dir, "staging", "files"), Path.Combine(_dir, "check-in.json"));
        _journal = new UpgradeJournalStore(Path.Combine(_dir, "broker", "upgrade.json"));
        Write(_paths.Install, "0.1.0");
        Write(_paths.Staged, "0.2.0");
    }

    public void Dispose() { try { Directory.Delete(_dir, true); } catch (IOException) { } }

    private static void Write(string root, string version)
    {
        foreach (string p in new[] { "Cabinet.Agent.Broker", "Cabinet.Agent.Network", "Cabinet.Agent.Updater" })
        {
            Directory.CreateDirectory(Path.Combine(root, p));
            File.WriteAllText(Path.Combine(root, p, p + ".exe"), "MZ " + version);
        }
    }

    private string Installed => File.ReadAllText(Path.Combine(_paths.Install, "Cabinet.Agent.Network", "Cabinet.Agent.Network.exe"))[3..];

    private UpgradeJournal Verified(UpgradePhase phase = UpgradePhase.Verified) => _journal.Write(new UpgradeJournal
    {
        UpgradeId = Guid.NewGuid(), Version = "0.2.0", FromVersion = "0.1.0", Phase = phase, StartedAt = DateTimeOffset.UtcNow.AddSeconds(-1),
        CheckInBy = phase == UpgradePhase.Waiting ? DateTimeOffset.UtcNow.AddMilliseconds(300) : null,
    });

    private Updater Make(FakeUpdaterPlatform platform) => new(_paths, _journal, platform, TimeProvider.System, _log.Add)
    { CheckInWindow = TimeSpan.FromMilliseconds(600), PollInterval = TimeSpan.FromMilliseconds(20), FileRetry = TimeSpan.FromMilliseconds(200) };

    [Fact]
    public void A_new_version_that_checks_in_stays_and_the_old_one_is_kept_as_backup()
    {
        Verified();
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => "0.2.0");
        UpgradeJournal j = Make(platform).Run();
        Assert.Equal(UpgradePhase.Succeeded, j.Phase);
        Assert.Equal("0.2.0", Installed);
        Assert.Equal("MZ 0.1.0", File.ReadAllText(Path.Combine(_paths.Backup, "Cabinet.Agent.Network", "Cabinet.Agent.Network.exe")));
        Assert.Equal(["stop", "start"], platform.Calls);
        Assert.False(Directory.Exists(_paths.Staged));
        Assert.Equal(UpgradePhase.Succeeded, _journal.Read()!.Phase);
    }

    [Fact]
    public void A_new_version_that_never_checks_in_is_replaced_by_the_old_one_on_its_own()
    {
        Verified();
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => null);
        var started = DateTimeOffset.UtcNow;
        UpgradeJournal j = Make(platform).Run();
        Assert.Equal(UpgradePhase.RolledBack, j.Phase);
        Assert.Equal(UpgradeCheck.CheckIn, j.Check);
        Assert.Contains("0.1.0 was restored", j.Message);
        Assert.Equal("0.1.0", Installed);
        Assert.False(Directory.Exists(_paths.Backup));
        Assert.Equal(["stop", "start", "stop", "start"], platform.Calls);
        Assert.True(DateTimeOffset.UtcNow - started >= TimeSpan.FromMilliseconds(550), "it waited the whole check-in window");
    }

    [Fact]
    public void A_check_in_by_the_old_version_or_from_before_the_upgrade_does_not_count()
    {
        Verified();
        CheckInFile.Write(_paths.CheckIn, "0.2.0", DateTimeOffset.UtcNow.AddHours(-1)); // left from an earlier attempt
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => "0.1.0");
        Assert.Equal(UpgradePhase.RolledBack, Make(platform).Run().Phase);
        Assert.Equal("0.1.0", Installed);
    }

    [Fact]
    public void A_check_in_written_in_advance_with_a_future_time_does_not_keep_a_broken_release()
    {
        // A compromised old network service could leave a check-in dated after the upgrade starts; it must not count.
        Verified();
        CheckInFile.Write(_paths.CheckIn, "0.2.0", DateTimeOffset.UtcNow.AddHours(1));
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => null);
        UpgradeJournal j = Make(platform).Run();
        Assert.Equal(UpgradePhase.RolledBack, j.Phase);
        Assert.Equal("0.1.0", Installed);
    }

    [Fact]
    public void A_damaged_check_in_file_does_not_count()
    {
        Verified();
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => null);
        File.WriteAllText(_paths.CheckIn, "{\"version\":\"0.2.0\",\"at\":\"" + DateTimeOffset.UtcNow.AddMinutes(1).ToString("yyyy-MM-ddTHH:mm:ssZ") + "\",\"x\":1}");
        Assert.Equal(UpgradePhase.RolledBack, Make(platform).Run().Phase);
    }

    [Fact]
    public void A_new_version_that_cannot_be_put_in_place_is_undone()
    {
        Verified();
        Directory.Delete(_paths.Staged, true); // nothing to copy
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => "0.2.0");
        UpgradeJournal j = Make(platform).Run();
        Assert.Equal(UpgradePhase.RolledBack, j.Phase);
        Assert.Equal(UpgradeCheck.Install, j.Check);
        Assert.Equal("0.1.0", Installed);
    }

    [Fact]
    public void Services_that_will_not_stop_leave_everything_as_it_was()
    {
        Verified();
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => "0.2.0") { FailStop = true };
        UpgradeJournal j = Make(platform).Run();
        Assert.Equal(UpgradePhase.Failed, j.Phase);
        Assert.Equal("0.1.0", Installed);
        Assert.False(Directory.Exists(_paths.Backup));
        Assert.Equal("start", platform.Calls[^1]);
    }

    [Fact]
    public void An_upgrade_cut_short_while_installing_is_undone_when_the_broker_starts()
    {
        Verified();
        Directory.Move(_paths.Install, _paths.Backup);
        Directory.CreateDirectory(Path.Combine(_paths.Install, "Cabinet.Agent.Broker")); // half copied
        _journal.Write(_journal.Read()! with { Phase = UpgradePhase.Installing });
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => null);
        UpgradeJournal j = Make(platform).Resume()!;
        Assert.Equal(UpgradePhase.RolledBack, j.Phase);
        Assert.Equal("0.1.0", Installed);
    }

    [Fact]
    public void An_upgrade_cut_short_while_waiting_keeps_waiting_then_decides()
    {
        Verified(UpgradePhase.Waiting);
        Directory.Move(_paths.Install, _paths.Backup);
        Write(_paths.Install, "0.2.0");
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => null);
        Assert.Equal(UpgradePhase.RolledBack, Make(platform).Resume()!.Phase);
        Assert.Equal("0.1.0", Installed);

        Verified(UpgradePhase.Waiting);
        Directory.Move(_paths.Install, _paths.Backup);
        Write(_paths.Install, "0.2.0");
        CheckInFile.Write(_paths.CheckIn, "0.2.0", DateTimeOffset.UtcNow);
        Assert.Equal(UpgradePhase.Succeeded, Make(platform).Resume()!.Phase);
        Assert.Equal("0.2.0", Installed);
    }

    [Theory]
    [InlineData(UpgradePhase.Verified)]
    [InlineData(UpgradePhase.Stopping)]
    [InlineData(UpgradePhase.BackingUp)]
    public void An_upgrade_cut_short_before_anything_moved_ends_as_failed_with_the_old_version_running(UpgradePhase phase)
    {
        Verified(phase);
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => null);
        UpgradeJournal j = Make(platform).Resume()!;
        Assert.Equal(UpgradePhase.Failed, j.Phase);
        Assert.Equal("0.1.0", Installed);
        Assert.Equal(["start"], platform.Calls);
    }

    [Fact]
    public void A_finished_or_damaged_journal_is_left_alone()
    {
        var platform = new FakeUpdaterPlatform(_paths.CheckIn, () => null);
        Assert.Null(Make(platform).Resume());
        Directory.CreateDirectory(Path.GetDirectoryName(_journal.Path)!);
        File.WriteAllText(_journal.Path, "{\"upgradeId\":\"x\"}");
        Assert.Null(_journal.Read());
        Assert.Null(Make(platform).Resume());
        Verified(UpgradePhase.Succeeded);
        Assert.Equal(UpgradePhase.Succeeded, Make(platform).Resume()!.Phase);
        Assert.Empty(platform.Calls);
    }
}

public sealed class FakeLauncher : IUpdaterLauncher
{
    public bool Running { get; set; }
    public List<string> Launched { get; } = [];
    public void Launch(string verb) => Launched.Add(verb);
}

public class UpgradeBrokerTests : IDisposable
{
    private readonly ReleaseFixture _f = new();
    private readonly FakeLauncher _launcher = new();
    private readonly UpgradeJournalStore _journal;
    private readonly UpgradeBroker _broker;

    public UpgradeBrokerTests()
    {
        _journal = new UpgradeJournalStore(Path.Combine(_f.Dir, "broker", "upgrade.json"));
        _broker = new UpgradeBroker(_f.Verifier(), _journal, _f.Downloads, _f.Staging, "0.1.0", _launcher, TimeProvider.System, _ => { });
    }

    public void Dispose() => _f.Dispose();

    [Fact]
    public void A_verified_release_is_journaled_and_the_updater_started_and_the_download_only_read()
    {
        _f.PlaceGood("0.2.0");
        var (output, error) = _broker.Start("0.2.0");
        Assert.Null(error);
        Assert.True(output!.Value.GetProperty("started").GetBoolean());
        Assert.Equal(["run"], _launcher.Launched);
        UpgradeJournal j = _journal.Read()!;
        Assert.Equal((UpgradePhase.Verified, "0.2.0", "0.1.0"), (j.Phase, j.Version, j.FromVersion));
        Assert.True(Directory.Exists(ReleaseVerifier.DownloadFolder(_f.Downloads, "0.2.0"))); // the network service removes its own download
    }

    [Fact]
    public void A_refused_release_answers_with_its_check_and_starts_nothing()
    {
        var files = ReleaseFixture.Programs();
        files["Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe"] = "MZ|unsigned";
        _f.PlaceGood("0.2.0", files);
        var (_, error) = _broker.Start("0.2.0");
        Assert.Equal(UpgradeCheck.Authenticode, error!.Check);
        Assert.Equal("signature_invalid", error.Code);
        Assert.Empty(_launcher.Launched);
        Assert.Null(_journal.Read());
        Assert.True(error.Message.Length <= 256);
    }

    [Fact]
    public void Only_one_upgrade_at_a_time_and_an_interrupted_one_is_resumed()
    {
        _f.PlaceGood("0.2.0");
        Assert.Null(_broker.Start("0.2.0").Error);
        _f.PlaceGood("0.3.0");
        Assert.Equal("unavailable", _broker.Start("0.3.0").Error!.Code);
        _broker.ResumeIfNeeded();
        Assert.Equal(["run", "resume"], _launcher.Launched);
        _launcher.Running = true;
        _broker.ResumeIfNeeded();
        Assert.Equal(2, _launcher.Launched.Count);
    }

    [Fact]
    public async Task The_broker_pipe_takes_an_upgrade_by_version_only()
    {
        _f.PlaceGood("0.2.0");
        var handler = new BrokerRequestHandler(new OperationRegistry(), upgrade: _broker.Start);
        var client = InProcessBrokerFor(handler);
        var (ok, error) = await client.UpgradeAsync("0.2.0", CancellationToken.None);
        Assert.True(ok, error?.Message);
        // A request that adds a path, or names no version, is refused before the broker reads it.
        foreach (string hostile in new[]
        {
            "{\"requestId\":\"0f8fad5b-d9cb-469f-a165-70867728950e\",\"kind\":\"upgrade\",\"version\":\"0.3.0\",\"path\":\"C:/Users/Public/agent.zip\"}",
            "{\"requestId\":\"0f8fad5b-d9cb-469f-a165-70867728950e\",\"kind\":\"upgrade\"}",
            "{\"requestId\":\"0f8fad5b-d9cb-469f-a165-70867728950e\",\"kind\":\"upgrade\",\"version\":\"../../x\"}",
        })
        {
            byte[]? reply = await handler.HandleAsync(Encoding.UTF8.GetBytes(hostile), CancellationToken.None);
            using JsonDocument doc = JsonDocument.Parse(reply!);
            Assert.Equal("invalid_params", doc.RootElement.GetProperty("error").GetProperty("code").GetString());
        }
        Assert.Equal(["run"], _launcher.Launched);
        // A broker that installs no upgrades says so.
        var none = InProcessBrokerFor(new BrokerRequestHandler(new OperationRegistry()));
        Assert.Equal("unavailable", (await none.UpgradeAsync("0.2.0", CancellationToken.None)).Error!.Code);
    }

    private static BrokerClient InProcessBrokerFor(BrokerRequestHandler handler) => new(_ => Task.FromResult<Stream>(new LoopbackBrokerStream(handler)));
}

public class SelfCheckTests : IDisposable
{
    private readonly ReleaseFixture _f = new();
    private readonly string _program;

    public SelfCheckTests()
    {
        _program = Path.Combine(_f.Dir, "program");
        foreach (var (name, content) in ReleaseFixture.Programs())
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(_program, name))!);
            File.WriteAllText(Path.Combine(_program, name), content);
        }
    }

    public void Dispose() => _f.Dispose();

    [Fact]
    public void Passes_when_every_binary_is_signed_by_the_agent_publisher()
    {
        SelfCheckResult r = new SelfCheck(_program, _f.Trust, _f.Authenticode).Run();
        Assert.True(r.Passed);
        Assert.Equal(4, r.Checked);
    }

    [Fact]
    public void Reports_each_file_that_was_changed_replaced_or_added()
    {
        File.WriteAllText(Path.Combine(_program, "Cabinet.Agent.Network", "Cabinet.Agent.Network.exe"), "MZ|tampered:Agent Publisher");
        File.WriteAllText(Path.Combine(_program, "Cabinet.Agent.Broker", "Cabinet.Agent.Broker.exe"), "MZ|signed:Impostor");
        File.WriteAllText(Path.Combine(_program, "Cabinet.Agent.Broker", "version.dll"), "MZ|unsigned");
        SelfCheckResult r = new SelfCheck(_program, _f.Trust, _f.Authenticode).Run();
        Assert.False(r.Passed);
        Assert.Equal(["Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe", "Cabinet.Agent.Broker/version.dll", "Cabinet.Agent.Network/Cabinet.Agent.Network.exe"],
            r.Problems.Select(p => p.File).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Reports_a_missing_service_program()
    {
        File.Delete(Path.Combine(_program, "Cabinet.Agent.Broker", "Cabinet.Agent.Broker.exe"));
        Assert.Contains(new SelfCheck(_program, _f.Trust, _f.Authenticode).Run().Problems, p => p.Problem == "It is missing.");
    }

    [Fact]
    public void A_build_with_no_publisher_says_it_cannot_check_itself()
    {
        using var dev = new ReleaseFixture(withPublisher: false);
        SelfCheckResult r = new SelfCheck(_program, dev.Trust, dev.Authenticode).Run();
        Assert.True(r.Skipped);
        Assert.False(r.Passed);
    }
}

/// <summary>A broker connection in memory: what the client writes is one framed request; reading returns the handler's framed answer.</summary>
public sealed class LoopbackBrokerStream(BrokerRequestHandler handler) : Stream
{
    private readonly MemoryStream _written = new();
    private MemoryStream? _reply;

    public override bool CanRead => true;
    public override bool CanWrite => true;
    public override bool CanSeek => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => _written.Write(buffer, offset, count);
    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count).GetAwaiter().GetResult();

    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token)
    {
        if (_reply is null)
        {
            _written.Position = 0;
            byte[]? request = await BrokerFraming.ReadAsync(_written, BrokerFraming.MaxRequestBytes, token);
            _reply = new MemoryStream();
            if (request is not null && await handler.HandleAsync(request, token) is { } answer) await BrokerFraming.WriteAsync(_reply, answer, token);
            _reply.Position = 0;
        }
        return _reply.Read(buffer, offset, count);
    }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
    {
        byte[] temp = new byte[buffer.Length];
        return new ValueTask<int>(ReadAsync(temp, 0, temp.Length, token).ContinueWith(t => { temp.AsSpan(0, t.Result).CopyTo(buffer.Span); return t.Result; }, token));
    }
}
