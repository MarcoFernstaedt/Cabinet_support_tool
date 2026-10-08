using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Packages;

/// <summary>
/// The trusted publisher list (contracts/trust), compiled into the agent so only a signed agent
/// upgrade can change it. A signer is trusted when its common name and organization match an
/// entry exactly and its certificate chain, built only from the certificates in the signature,
/// ends at that entry's pinned root. Nothing is downloaded while building the chain.
/// </summary>
public sealed class TrustList
{
    public TrustedPublishers List { get; }
    private readonly Dictionary<string, X509Certificate2> _roots = new(StringComparer.Ordinal);

    public static TrustList Compiled { get; } = LoadCompiled();

    public TrustList(TrustedPublishers list, IReadOnlyDictionary<string, X509Certificate2> rootsBySha256)
    {
        List = list;
        foreach (TrustedRoot r in list.Roots)
        {
            if (!rootsBySha256.TryGetValue(r.Sha256, out X509Certificate2? cert) || Convert.ToHexString(SHA256.HashData(cert.RawData)).ToLowerInvariant() != r.Sha256)
                throw new InvalidOperationException($"The trusted root {r.Name} does not match its pinned hash.");
            _roots[r.Sha256] = cert!;
        }
    }

    private static TrustList LoadCompiled()
    {
        Assembly a = typeof(TrustList).Assembly;
        return Load(name =>
        {
            using Stream s = a.GetManifestResourceStream("trust/" + name) ?? throw new InvalidOperationException($"trust/{name} is not compiled into the agent.");
            return new StreamReader(s).ReadToEnd();
        });
    }

    /// <summary>A list from a folder laid out like contracts/trust. Only the test agent uses this; the real agent uses <see cref="Compiled"/>.</summary>
    public static TrustList FromFolder(string folder) =>
        Load(name => File.ReadAllText(Path.Combine(folder, Path.GetFileName(name))));

    private static TrustList Load(Func<string, string> Read)
    {
        string json = Read("trusted-publishers.json");
        using (JsonDocument doc = JsonDocument.Parse(json))
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("trusted-publishers"), doc.RootElement))
                throw new InvalidOperationException("The compiled-in trusted publisher list does not match its contract.");
        var list = JsonSerializer.Deserialize<TrustedPublishers>(json, ContractJson.Options)!;
        return new TrustList(list, list.Roots.ToDictionary(r => r.Sha256, r => X509Certificate2.CreateFromPem(Read(r.File))));
    }

    /// <summary>The publisher entry the signer matches for this package type, or null.</summary>
    public TrustedPublisher? Match(X509Certificate2 signer, X509Certificate2Collection signatureCerts, PackageType type)
    {
        string? cn = signer.GetNameInfo(X509NameType.SimpleName, false);
        string? org = Attribute(signer.SubjectName, "2.5.4.10");
        foreach (TrustedPublisher p in List.Publishers.Where(p => p.PackageTypes.Contains(type)))
        {
            if (cn != p.CommonName || org != p.Organization) continue;
            if (ChainsTo(signer, signatureCerts, _roots[p.Root])) return p;
        }
        return null;
    }

    internal static bool ChainsTo(X509Certificate2 leaf, X509Certificate2Collection extra, X509Certificate2 root)
    {
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(root);
        chain.ChainPolicy.ExtraStore.AddRange(extra);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.DisableCertificateDownloads = true; // the broker never opens a network connection
        // Signing certificates expire long before the packages they signed; the signature's timestamp is Windows' check.
        chain.ChainPolicy.VerificationFlags = X509VerificationFlags.IgnoreNotTimeValid | X509VerificationFlags.IgnoreCtlNotTimeValid;
        bool ok = chain.Build(leaf);
        if (!ok && chain.ChainStatus.Any(s => (s.Status & ~(X509ChainStatusFlags.NotTimeValid | X509ChainStatusFlags.NotTimeNested)) != 0)) return false;
        X509ChainElement top = chain.ChainElements[^1];
        return top.Certificate.RawData.AsSpan().SequenceEqual(root.RawData);
    }

    internal static string? Attribute(X500DistinguishedName name, string oid)
    {
        foreach (X500RelativeDistinguishedName rdn in name.EnumerateRelativeDistinguishedNames())
            if (rdn.GetSingleElementType().Value == oid) return rdn.GetSingleElementValue();
        return null;
    }
}
