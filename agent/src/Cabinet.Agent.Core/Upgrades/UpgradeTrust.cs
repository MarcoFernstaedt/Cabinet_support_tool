using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Packages;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>
/// What an agent release must be signed with (contracts/trust/upgrade, compiled in): the public half of the
/// release key the KMS holds, plus at most one future key while the key is changed, and the code-signing
/// publisher every agent binary must carry. Only a signed agent upgrade can change any of it; the server has
/// no say. A build with no keys accepts no upgrade, and a build with no publisher has no own-file check.
/// </summary>
public sealed class UpgradeTrust : IDisposable
{
    public const string Algorithm = "ecdsa-p256-sha256";
    public const string Product = "mashura-cabinet-agent";

    private readonly Dictionary<string, ECDsa> _keys = new(StringComparer.Ordinal);
    private readonly List<(UpgradePublisher Publisher, X509Certificate2 Root)> _publishers = [];

    public UpgradeKeys List { get; }
    public bool HasKeys => _keys.Count > 0;
    public bool HasPublisher => _publishers.Count > 0;
    // Only present in an explicitly built development agent. The server cannot turn this on after enrollment.
#if ALLOW_UNSIGNED_DEVELOPMENT_UPGRADES
    public static readonly bool AllowsUnsignedDevelopmentUpgrades = true;
#else
    public static readonly bool AllowsUnsignedDevelopmentUpgrades = false;
#endif

    private static readonly Lazy<UpgradeTrust> CompiledTrust = new(() => Load(name =>
    {
        using Stream s = typeof(UpgradeTrust).Assembly.GetManifestResourceStream("upgrade/" + name)
            ?? throw new InvalidOperationException($"upgrade/{name} is not compiled into the agent.");
        return new StreamReader(s).ReadToEnd();
    }));

    /// <summary>The keys and publisher compiled into this agent.</summary>
    public static UpgradeTrust Compiled => CompiledTrust.Value;

    /// <summary>A trust file laid out like contracts/trust/upgrade. Tests only; the agent uses <see cref="Compiled"/>.</summary>
    public static UpgradeTrust FromFolder(string folder) => Load(name => File.ReadAllText(Path.Combine(folder, Path.GetFileName(name))));

    private static UpgradeTrust Load(Func<string, string> read)
    {
        string json = read("upgrade-keys.json");
        using (JsonDocument doc = JsonDocument.Parse(json))
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("upgrade-keys"), doc.RootElement))
                throw new InvalidOperationException("The compiled-in upgrade keys do not match their contract.");
        var list = JsonSerializer.Deserialize<UpgradeKeys>(json, ContractJson.Options)!;
        return new UpgradeTrust(list, list.Publishers.ToDictionary(p => p.RootFile, p => X509Certificate2.CreateFromPem(read(p.RootFile))));
    }

    public UpgradeTrust(UpgradeKeys list, IReadOnlyDictionary<string, X509Certificate2> rootsByFile)
    {
        List = list;
        foreach (UpgradeKey k in list.Keys)
        {
            byte[] spki = Convert.FromBase64String(k.PublicKey);
            if (Hex(SHA256.HashData(spki)) != k.KeyId) throw new InvalidOperationException($"Upgrade key {k.Name}: its keyId is not the hash of the key.");
            var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(spki, out _);
            if (key.KeySize != 256 || key.ExportParameters(false).Curve.Oid.Value != ECCurve.NamedCurves.nistP256.Oid.Value)
                throw new InvalidOperationException($"Upgrade key {k.Name} is not a P-256 key.");
            _keys[k.KeyId] = key;
        }
        foreach (UpgradePublisher p in list.Publishers)
        {
            if (!rootsByFile.TryGetValue(p.RootFile, out X509Certificate2? root) || Hex(SHA256.HashData(root.RawData)) != p.Root)
                throw new InvalidOperationException($"The pinned root for {p.CommonName} does not match its hash.");
            _publishers.Add((p, root));
        }
    }

    /// <summary>Checks the detached signature over the manifest's exact bytes. Nothing in the manifest is read before this passes.</summary>
    public bool VerifyManifest(ReadOnlySpan<byte> manifest, UpgradeSignature signature, out string problem)
    {
        problem = "";
        if (!HasKeys) { problem = "This agent has no release key compiled in, so it accepts no upgrade."; return false; }
        if (signature.Algorithm != Algorithm) { problem = $"The signature uses {signature.Algorithm}, not {Algorithm}."; return false; }
        if (!_keys.TryGetValue(signature.KeyId, out ECDsa? key)) { problem = "The manifest is signed with a key this agent does not hold."; return false; }
        byte[] sig;
        try { sig = Convert.FromBase64String(signature.Signature); }
        catch (FormatException) { problem = "The signature is not base64."; return false; }
        bool ok;
        try { ok = key.VerifyData(manifest, sig, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence); }
        catch (CryptographicException) { ok = false; }
        if (!ok) problem = "The manifest's signature does not verify against the agent's release key.";
        return ok;
    }

    /// <summary>The trusted publisher's common name when the signer is the agent's own code-signing publisher, chained to its pinned root; otherwise null.</summary>
    public string? MatchPublisher(X509Certificate2 signer, X509Certificate2Collection signatureCerts)
    {
        string? cn = signer.GetNameInfo(X509NameType.SimpleName, false);
        string? org = TrustList.Attribute(signer.SubjectName, "2.5.4.10");
        foreach (var (p, root) in _publishers)
            if (cn == p.CommonName && org == p.Organization && TrustList.ChainsTo(signer, signatureCerts, root)) return p.CommonName;
        return null;
    }

    private static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

    public void Dispose()
    {
        foreach (ECDsa k in _keys.Values) k.Dispose();
    }
}
