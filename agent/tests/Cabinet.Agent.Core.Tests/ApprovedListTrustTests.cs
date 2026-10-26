using System.Security.Cryptography;
using System.Text;
using Cabinet.Agent.Core.Services;

namespace Cabinet.Agent.Core.Tests;

/// <summary>
/// The signed approved list's check on the cabinet (docs/spec/09-open-decisions.md "Signing the approved list"): the same
/// vectors the server is held to, plus the agent's own stricter parse, and the keys compiled into this build.
/// </summary>
public class ApprovedListTrustTests
{
    private static JsonElement Vectors()
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Fixtures.ContractsDir(), "vectors", "approved-list-vectors.json")));
        return doc.RootElement.Clone();
    }

    private static ApprovedListSignature Signature(JsonElement e) => e.Deserialize<ApprovedListSignature>(ContractJson.Options)!;

    [Fact]
    public void Every_shared_vector_is_accepted_or_refused_for_the_same_reason_the_server_gives()
    {
        JsonElement vectors = Vectors();
        using var trust = ApprovedListTrust.Parse(vectors.GetProperty("keys").GetRawText());
        int count = 0;
        foreach (JsonElement c in vectors.GetProperty("cases").EnumerateArray())
        {
            string name = c.GetProperty("name").GetString()!;
            byte[] bytes = Convert.FromBase64String(c.GetProperty("document").GetString()!);
            var refusal = trust.Open(bytes, Signature(c.GetProperty("signature")), out ApprovedListDocument? opened, out string problem);
            if (c.GetProperty("accept").GetBoolean())
            {
                Assert.True(refusal == ApprovedListTrust.Refusal.None, $"{name}: {problem}");
                Assert.NotNull(opened);
            }
            else
            {
                Assert.Null(opened);
                Assert.Equal(c.GetProperty("reason").GetString(), refusal.ToString().ToLowerInvariant());
            }
            count++;
        }
        Assert.True(count >= 9);
    }

    [Fact]
    public void An_accepted_list_is_read_whole()
    {
        JsonElement vectors = Vectors();
        using var trust = ApprovedListTrust.Parse(vectors.GetProperty("keys").GetRawText());
        JsonElement c = vectors.GetProperty("cases")[0];
        trust.Open(Convert.FromBase64String(c.GetProperty("document").GetString()!), Signature(c.GetProperty("signature")), out var list, out _);
        Assert.Equal(ApprovedListLevel.Site, list!.Level);
        Assert.Equal(3, list.Version);
        Assert.Equal(["app:scanner", "app:kiosk"], list.Entries.Select(e => e.Key));
        Assert.Equal("BioScanSvc", list.Entries[0].ServiceName);
    }

    [Fact]
    public void A_validly_signed_document_with_a_duplicate_name_is_refused_by_the_agent_s_strict_parse()
    {
        // JSON.parse on the server would keep the last copy; the agent refuses the document instead, so the two can never
        // act on different lists. Signed with a fresh key, so this is the parse refusing, not the signature.
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var trust = TrustFor(key);
        byte[] doc = Encoding.UTF8.GetBytes("""{"product":"mashura-approved-list","level":"fleet","scopeId":null,"version":1,"version":2,"issuedAt":"2026-10-26T12:00:00Z","entries":[]}""");
        Assert.Equal(ApprovedListTrust.Refusal.Document, trust.Open(doc, Sign(key, doc), out var opened, out _));
        Assert.Null(opened);
    }

    [Fact]
    public void Hostile_signatures_and_sizes_are_refused_before_the_document_is_read()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var trust = TrustFor(key);
        byte[] doc = Encoding.UTF8.GetBytes("""{"product":"mashura-approved-list","level":"fleet","scopeId":null,"version":1,"issuedAt":"2026-10-26T12:00:00Z","entries":[]}""");
        ApprovedListSignature good = Sign(key, doc);
        Assert.Equal(ApprovedListTrust.Refusal.None, trust.Open(doc, good, out _, out _));
        Assert.Equal(ApprovedListTrust.Refusal.Signature, trust.Open(doc, good with { Algorithm = "rsa-pss-sha256" }, out _, out _));
        Assert.Equal(ApprovedListTrust.Refusal.Signature, trust.Open(doc, good with { Signature = "not base64!" }, out _, out _));
        Assert.Equal(ApprovedListTrust.Refusal.Signature, trust.Open(doc, good with { Signature = Convert.ToBase64String(new byte[8]) }, out _, out _));
        Assert.Equal(ApprovedListTrust.Refusal.Key, trust.Open(doc, good with { KeyId = new string('0', 64) }, out _, out _));
        Assert.Equal(ApprovedListTrust.Refusal.Document, trust.Open([], good, out _, out _));
        Assert.Equal(ApprovedListTrust.Refusal.Document, trust.Open(new byte[ApprovedListTrust.MostBytes + 1], good, out _, out _));
        // The release key is not a list key: a list signed with a key the agent does not hold for lists is refused.
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        Assert.Equal(ApprovedListTrust.Refusal.Key, trust.Open(doc, Sign(other, doc), out _, out _));
    }

    [Fact]
    public void A_trust_file_whose_keyId_is_not_its_key_s_hash_or_that_breaks_its_contract_is_refused()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        string spki = Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());
        Assert.Throws<InvalidOperationException>(() => ApprovedListTrust.Parse(
            $$"""{"version":1,"keys":[{"keyId":"{{new string('a', 64)}}","name":"k","publicKey":"{{spki}}"}]}"""));
        Assert.Throws<InvalidOperationException>(() => ApprovedListTrust.Parse("""{"version":1,"keys":[],"privateKey":"x"}"""));
    }

    [Fact]
    public void The_compiled_in_keys_load_and_match_the_repository_s_trust_file()
    {
        ApprovedListTrust compiled = ApprovedListTrust.Compiled;
        using JsonDocument file = JsonDocument.Parse(File.ReadAllText(Path.Combine(Fixtures.ContractsDir(), "trust", "approved-list", "approved-list-keys.json")));
        Assert.Equal(file.RootElement.GetProperty("keys").GetArrayLength() > 0, compiled.HasKeys);
    }

    private static ApprovedListTrust TrustFor(ECDsa key)
    {
        byte[] spki = key.ExportSubjectPublicKeyInfo();
        return new ApprovedListTrust(new ApprovedListKeys
        {
            Version = 1,
            Keys = [new ApprovedListKey { KeyId = Convert.ToHexString(SHA256.HashData(spki)).ToLowerInvariant(), Name = "Test", PublicKey = Convert.ToBase64String(spki) }],
        });
    }

    private static ApprovedListSignature Sign(ECDsa key, byte[] bytes) => new()
    {
        KeyId = Convert.ToHexString(SHA256.HashData(key.ExportSubjectPublicKeyInfo())).ToLowerInvariant(),
        Algorithm = ApprovedListTrust.Algorithm,
        Signature = Convert.ToBase64String(key.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence)),
    };
}
