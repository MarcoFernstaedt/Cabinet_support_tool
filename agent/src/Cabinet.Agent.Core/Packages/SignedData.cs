using System.Formats.Asn1;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Cabinet.Agent.Core.Packages;

/// <summary>A signature the platform will not accept, with the rejection code to report.</summary>
public sealed class PackageRefusedException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// A PKCS#7 SignedData (a driver catalog, or an Authenticode signature) verified by hand:
/// the signed content's digest must match the signed attribute, and the signer's public key
/// must verify the signature over those attributes. The same rules the server applies, so a
/// package one side accepts the other accepts too. Only SHA-256 and stronger are accepted for
/// signatures. Certificate trust is checked separately, against the trusted publisher list.
/// </summary>
public sealed class SignedData
{
    public const string OidSignedData = "1.2.840.113549.1.7.2";
    public const string OidData = "1.2.840.113549.1.7.1";
    public const string OidCtl = "1.3.6.1.4.1.311.10.1";
    public const string OidSpcIndirectData = "1.3.6.1.4.1.311.2.1.4";
    private const string OidMessageDigest = "1.2.840.113549.1.9.4";
    private const string OidContentType = "1.2.840.113549.1.9.3";

    public required string ContentType { get; init; }
    /// <summary>The signed content's value bytes (what the digest covers).</summary>
    public required byte[] Content { get; init; }
    /// <summary>The content as DER for parsing: the inner structure itself, whether it was carried directly (PKCS #7) or wrapped in an OCTET STRING (CMS).</summary>
    public required byte[] ContentEncoded { get; init; }
    public required X509Certificate2 Signer { get; init; }
    public required X509Certificate2Collection Certificates { get; init; }

    public const int MaxBytes = 64 * 1024 * 1024;

    /// <summary>Parses and verifies. Throws <see cref="PackageRefusedException"/> (signature_invalid) on anything wrong.</summary>
    public static SignedData Verify(ReadOnlyMemory<byte> der)
    {
        try { return VerifyCore(der); }
        catch (Exception e) when (e is AsnContentException or CryptographicException or ArgumentException or InvalidOperationException or FormatException)
        {
            throw new PackageRefusedException("signature_invalid", "The signature is malformed.");
        }
    }

    private static SignedData VerifyCore(ReadOnlyMemory<byte> der)
    {
        if (der.Length == 0 || der.Length > MaxBytes) throw new PackageRefusedException("signature_invalid", "The signature is empty or too large.");
        var outer = new AsnReader(der, AsnEncodingRules.BER).ReadSequence();
        if (outer.ReadObjectIdentifier() != OidSignedData) throw new PackageRefusedException("signature_invalid", "Not a signed message.");
        var signedData = outer.ReadSequence(new Asn1Tag(TagClass.ContextSpecific, 0)).ReadSequence();
        signedData.ReadInteger(); // version
        signedData.ReadSetOf();   // digestAlgorithms
        var encap = signedData.ReadSequence();
        string contentType = encap.ReadObjectIdentifier();
        if (!encap.HasData) throw new PackageRefusedException("signature_invalid", "The signed message has no content.");
        var explicitContent = encap.ReadSequence(new Asn1Tag(TagClass.ContextSpecific, 0));
        byte[] encoded = explicitContent.ReadEncodedValue().ToArray();
        // PKCS #7: the digest covers the content octets of the DER encoding, without its tag and length.
        var contentReader = new AsnReader(encoded, AsnEncodingRules.BER);
        Asn1Tag contentTag = contentReader.PeekTag();
        bool wrapped = contentTag.HasSameClassAndValue(Asn1Tag.PrimitiveOctetString) || contentTag.HasSameClassAndValue(new Asn1Tag(UniversalTagNumber.OctetString, true));
        byte[] value = wrapped ? contentReader.ReadOctetString() : ValueOf(encoded);
        if (wrapped) encoded = value;

        var certs = new X509Certificate2Collection();
        if (signedData.PeekTag().HasSameClassAndValue(new Asn1Tag(TagClass.ContextSpecific, 0, true)))
        {
            var set = signedData.ReadSetOf(new Asn1Tag(TagClass.ContextSpecific, 0));
            while (set.HasData)
            {
                Asn1Tag tag = set.PeekTag();
                ReadOnlyMemory<byte> item = set.ReadEncodedValue();
                if (tag.HasSameClassAndValue(Asn1Tag.Sequence)) certs.Add(new X509Certificate2(item.ToArray()));
            }
        }
        if (signedData.HasData && signedData.PeekTag().HasSameClassAndValue(new Asn1Tag(TagClass.ContextSpecific, 1, true))) signedData.ReadEncodedValue(); // CRLs
        var signers = signedData.ReadSetOf();
        var signerInfo = signers.ReadSequence();
        if (signers.HasData) throw new PackageRefusedException("signature_invalid", "More than one signer.");

        signerInfo.ReadInteger();
        X509Certificate2 signer;
        if (signerInfo.PeekTag().HasSameClassAndValue(Asn1Tag.Sequence))
        {
            var ias = signerInfo.ReadSequence();
            byte[] issuer = ias.ReadEncodedValue().ToArray();
            byte[] serial = ias.ReadIntegerBytes().ToArray();
            signer = certs.FirstOrDefault(c => c.IssuerName.RawData.AsSpan().SequenceEqual(issuer) && SameSerial(c.SerialNumberBytes.Span, serial))
                ?? throw new PackageRefusedException("signature_invalid", "The signer's certificate is not in the signature.");
        }
        else
        {
            byte[] ski = signerInfo.ReadOctetString(new Asn1Tag(TagClass.ContextSpecific, 0));
            signer = certs.FirstOrDefault(c => c.Extensions.OfType<X509SubjectKeyIdentifierExtension>().Any(x => Convert.FromHexString(x.SubjectKeyIdentifier!).AsSpan().SequenceEqual(ski)))
                ?? throw new PackageRefusedException("signature_invalid", "The signer's certificate is not in the signature.");
        }
        HashAlgorithmName digestAlg = HashFor(ReadAlgorithm(signerInfo));
        if (!signerInfo.PeekTag().HasSameClassAndValue(new Asn1Tag(TagClass.ContextSpecific, 0, true)))
            throw new PackageRefusedException("signature_invalid", "The signature has no signed attributes.");
        byte[] attrsEncoded = signerInfo.ReadEncodedValue().ToArray();
        string sigAlg = ReadAlgorithm(signerInfo);
        byte[] signature = signerInfo.ReadOctetString();

        // The signed attributes: content type and message digest must agree with the content.
        byte[]? messageDigest = null;
        string? attrContentType = null;
        var attrs = new AsnReader(attrsEncoded, AsnEncodingRules.BER).ReadSetOf(new Asn1Tag(TagClass.ContextSpecific, 0));
        while (attrs.HasData)
        {
            var attr = attrs.ReadSequence();
            string oid = attr.ReadObjectIdentifier();
            var values = attr.ReadSetOf();
            if (oid == OidMessageDigest) messageDigest = values.ReadOctetString();
            else if (oid == OidContentType) attrContentType = values.ReadObjectIdentifier();
        }
        if (messageDigest is null || attrContentType != contentType) throw new PackageRefusedException("signature_invalid", "The signed attributes are incomplete.");
        byte[] actual = Hash(digestAlg, value);
        if (!CryptographicOperations.FixedTimeEquals(actual, messageDigest))
            throw new PackageRefusedException("signature_invalid", "The signed content was changed after signing.");

        // The signature covers the DER of the attributes as a SET (tag 0x31), not as [0].
        byte[] signedBytes = (byte[])attrsEncoded.Clone();
        signedBytes[0] = 0x31;
        if (!VerifySignature(signer, sigAlg, digestAlg, signedBytes, signature))
            throw new PackageRefusedException("signature_invalid", "The signature does not verify.");
        return new SignedData { ContentType = contentType, Content = value, ContentEncoded = encoded, Signer = signer, Certificates = certs };
    }

    private static bool SameSerial(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        static ReadOnlySpan<byte> Trim(ReadOnlySpan<byte> x) { int i = 0; while (i < x.Length - 1 && x[i] == 0) i++; return x[i..]; }
        return Trim(a).SequenceEqual(Trim(b));
    }

    /// <summary>The value bytes of one DER element (skips its tag and length).</summary>
    public static byte[] ValueOf(byte[] encoded)
    {
        AsnDecoder.ReadEncodedValue(encoded, AsnEncodingRules.BER, out int contentOffset, out int contentLength, out _);
        return encoded.AsSpan(contentOffset, contentLength).ToArray();
    }

    private static string ReadAlgorithm(AsnReader reader)
    {
        var alg = reader.ReadSequence();
        string oid = alg.ReadObjectIdentifier();
        return oid;
    }

    public static HashAlgorithmName HashFor(string oid) => oid switch
    {
        "2.16.840.1.101.3.4.2.1" => HashAlgorithmName.SHA256,
        "2.16.840.1.101.3.4.2.2" => HashAlgorithmName.SHA384,
        "2.16.840.1.101.3.4.2.3" => HashAlgorithmName.SHA512,
        _ => throw new PackageRefusedException("signature_invalid", "The signature uses a digest weaker than SHA-256."),
    };

    public static byte[] Hash(HashAlgorithmName alg, ReadOnlySpan<byte> data) =>
        alg == HashAlgorithmName.SHA256 ? SHA256.HashData(data) : alg == HashAlgorithmName.SHA384 ? SHA384.HashData(data) : SHA512.HashData(data);

    private static bool VerifySignature(X509Certificate2 signer, string sigAlg, HashAlgorithmName digest, byte[] data, byte[] signature)
    {
        switch (sigAlg)
        {
            case "1.2.840.113549.1.1.1": // rsaEncryption, with the digest algorithm above
            case "1.2.840.113549.1.1.11" when digest == HashAlgorithmName.SHA256:
            case "1.2.840.113549.1.1.12" when digest == HashAlgorithmName.SHA384:
            case "1.2.840.113549.1.1.13" when digest == HashAlgorithmName.SHA512:
                using (RSA? rsa = signer.GetRSAPublicKey())
                    return rsa is not null && rsa.VerifyData(data, signature, digest, RSASignaturePadding.Pkcs1);
            case "1.2.840.10045.4.3.2" when digest == HashAlgorithmName.SHA256:
            case "1.2.840.10045.4.3.3" when digest == HashAlgorithmName.SHA384:
            case "1.2.840.10045.4.3.4" when digest == HashAlgorithmName.SHA512:
            case "1.2.840.10045.2.1":
                using (ECDsa? ec = signer.GetECDsaPublicKey())
                    return ec is not null && ec.VerifyData(data, signature, digest, DSASignatureFormat.Rfc3279DerSequence);
            default:
                throw new PackageRefusedException("signature_invalid", "The signature algorithm is not accepted.");
        }
    }
}
