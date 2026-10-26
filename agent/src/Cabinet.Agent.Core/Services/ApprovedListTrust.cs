using System.Security.Cryptography;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Services;

/// <summary>
/// The Admin list-signing keys compiled into this agent (contracts/trust/approved-list), and the check a signed approved list
/// must pass (docs/spec/09-open-decisions.md "Signing the approved list"). The same check as the server's
/// (server/src/services/approved-list-signing.ts), held to the same shared vectors (contracts/vectors/approved-list-vectors.json).
///
/// The signature is checked over the document's exact bytes before a byte of the document is read; only then is it parsed,
/// strictly, and held to its contract. Only a signed agent upgrade can change the keys; the server has no say. A build with
/// no key does not check list signatures yet.
/// </summary>
public sealed class ApprovedListTrust : IDisposable
{
    public const string Algorithm = "ecdsa-p256-sha256";
    public const string Product = "mashura-approved-list";
    /// <summary>The largest signed document accepted: 32 entries at their longest fit in well under this.</summary>
    public const int MostBytes = 32 * 1024;

    private readonly Dictionary<string, ECDsa> _keys = new(StringComparer.Ordinal);

    private static readonly Lazy<ApprovedListTrust> CompiledTrust = new(() =>
    {
        using Stream s = typeof(ApprovedListTrust).Assembly.GetManifestResourceStream("approved-list/approved-list-keys.json")
            ?? throw new InvalidOperationException("approved-list/approved-list-keys.json is not compiled into the agent.");
        return Parse(new StreamReader(s).ReadToEnd());
    });

    /// <summary>The keys compiled into this agent.</summary>
    public static ApprovedListTrust Compiled => CompiledTrust.Value;

    /// <summary>A trust file's text (approved-list-keys.json). Tests, and the build's own copy through <see cref="Compiled"/>.</summary>
    public static ApprovedListTrust Parse(string json)
    {
        using (JsonDocument doc = JsonDocument.Parse(json))
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("approved-list-keys"), doc.RootElement))
                throw new InvalidOperationException("The list-signing keys do not match their contract.");
        return new ApprovedListTrust(JsonSerializer.Deserialize<ApprovedListKeys>(json, ContractJson.Options)!);
    }

    public ApprovedListTrust(ApprovedListKeys list)
    {
        foreach (ApprovedListKey k in list.Keys)
        {
            byte[] spki = Convert.FromBase64String(k.PublicKey);
            if (Convert.ToHexString(SHA256.HashData(spki)).ToLowerInvariant() != k.KeyId)
                throw new InvalidOperationException($"List-signing key {k.Name}: its keyId is not the hash of the key.");
            var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(spki, out _);
            if (key.KeySize != 256 || key.ExportParameters(false).Curve.Oid.Value != ECCurve.NamedCurves.nistP256.Oid.Value)
                throw new InvalidOperationException($"List-signing key {k.Name} is not a P-256 key.");
            _keys[k.KeyId] = key;
        }
    }

    /// <summary>Whether this build checks list signatures at all. With no key it does not, and treats the list as before signing existed.</summary>
    public bool HasKeys => _keys.Count > 0;

    /// <summary>Why a signed list was refused: the key is not one this agent holds, the signature does not verify, or the signed bytes are not an approved list.</summary>
    public enum Refusal { None, Key, Signature, Document }

    /// <summary>
    /// Opens a signed list: the signature over <paramref name="document"/>'s exact bytes first, then the document itself.
    /// <paramref name="opened"/> is set only when every check passed.
    /// </summary>
    public Refusal Open(ReadOnlySpan<byte> document, ApprovedListSignature signature, out ApprovedListDocument? opened, out string problem)
    {
        opened = null;
        problem = "";
        if (document.Length == 0 || document.Length > MostBytes) { problem = $"The signed list is empty or larger than {MostBytes} bytes."; return Refusal.Document; }
        if (signature.Algorithm != Algorithm) { problem = $"The signature uses {signature.Algorithm}, not {Algorithm}."; return Refusal.Signature; }
        if (!_keys.TryGetValue(signature.KeyId, out ECDsa? key)) { problem = "The list is signed with a key this agent does not hold."; return Refusal.Key; }
        byte[] sig;
        try { sig = Convert.FromBase64String(signature.Signature); }
        catch (FormatException) { problem = "The signature is not base64."; return Refusal.Signature; }
        bool good;
        try { good = key.VerifyData(document, sig, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence); }
        catch (CryptographicException) { good = false; }
        if (!good) { problem = "The list's signature does not verify against the agent's list-signing key."; return Refusal.Signature; }

        // Signed: now, and only now, the document is read. Strictly (no duplicate names), then against its contract.
        if (!StrictJson.TryParse(document.ToArray(), MostBytes, out JsonDocument? parsed)) { problem = "The signed list is not JSON."; return Refusal.Document; }
        using (parsed)
        {
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("approved-list"), parsed!.RootElement))
            { problem = "The signed list does not match its contract."; return Refusal.Document; }
            var list = parsed.RootElement.Deserialize<ApprovedListDocument>(ContractJson.Options)!;
            if (list.Product != Product) { problem = "The signed document is not an approved list."; return Refusal.Document; }
            opened = list;
        }
        return Refusal.None;
    }

    public void Dispose()
    {
        foreach (ECDsa k in _keys.Values) k.Dispose();
    }
}
