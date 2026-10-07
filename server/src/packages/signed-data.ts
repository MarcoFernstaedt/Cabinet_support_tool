// PKCS #7 SignedData verified by hand, by the same rules as the agent
// (agent/src/Cabinet.Agent.Core/Packages/SignedData.cs): the signed content's digest must match
// the signed attribute, and the signer's key must verify the signature over the attributes.
// Only SHA-256 and stronger are accepted. Trust in the certificate is decided separately.
import { createHash, verify, X509Certificate } from "node:crypto";
import { children, expect, list, oid, PackageRefused, raw, read, value, type El } from "./asn1.js";

export const OID = {
  signedData: "1.2.840.113549.1.7.2",
  ctl: "1.3.6.1.4.1.311.10.1",
  spcIndirectData: "1.3.6.1.4.1.311.2.1.4",
  messageDigest: "1.2.840.113549.1.9.4",
  contentType: "1.2.840.113549.1.9.3",
} as const;

const DIGESTS: Record<string, string> = { "2.16.840.1.101.3.4.2.1": "sha256", "2.16.840.1.101.3.4.2.2": "sha384", "2.16.840.1.101.3.4.2.3": "sha512" };
const SIGNATURES: Record<string, "rsa" | "ec" | undefined> = {
  "1.2.840.113549.1.1.1": "rsa", "1.2.840.113549.1.1.11": "rsa", "1.2.840.113549.1.1.12": "rsa", "1.2.840.113549.1.1.13": "rsa",
  "1.2.840.10045.2.1": "ec", "1.2.840.10045.4.3.2": "ec", "1.2.840.10045.4.3.3": "ec", "1.2.840.10045.4.3.4": "ec",
};

export interface Signed {
  contentType: string;
  /** What the digest covers: the content's value octets. */
  content: Buffer;
  /** The inner structure as DER, for parsing (unwrapped if it was carried in an OCTET STRING). */
  contentDer: Buffer;
  signer: X509Certificate;
  certificates: X509Certificate[];
}

const invalid = (m: string): never => { throw new PackageRefused("signature_invalid", m); };

/** The issuer name (DER) and serial number of a certificate, read from its encoding. */
export function issuerAndSerial(cert: X509Certificate): { issuer: Buffer; serial: Buffer } {
  const tbs = list(list(read(cert.raw))[0]!);
  let i = 0;
  if (tbs[0]!.tag === 0xa0) i++; // version
  return { serial: stripZeros(value(tbs[i]!)), issuer: raw(tbs[i + 2]!) };
}

const stripZeros = (b: Buffer): Buffer => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };

export function verifySignedData(der: Buffer): Signed {
  if (der.length === 0 || der.length > 64 * 1024 * 1024) invalid("The signature is empty or too large.");
  const outer = read(der);
  if (outer.end !== der.length) invalid("Trailing data after the signature.");
  const [type, explicit] = list(expect(outer, 0x30, "ContentInfo"));
  if (oid(type!) !== OID.signedData) invalid("Not a signed message.");
  const sd = list(expect(list(expect(explicit, 0xa0, "content"))[0], 0x30, "SignedData"), 8);
  let i = 0;
  expect(sd[i++], 0x02, "version");
  expect(sd[i++], 0x31, "digest algorithms");
  const encap = list(expect(sd[i++], 0x30, "content info"));
  const contentType = oid(encap[0]!);
  if (!encap[1]) invalid("The signed message has no content.");
  const inner = list(expect(encap[1], 0xa0, "content"))[0]!;
  const wrapped = inner.tag === 0x04;
  const content = value(inner);
  const contentDer = wrapped ? content : raw(inner);

  const certificates: X509Certificate[] = [];
  if (sd[i]?.tag === 0xa0) {
    for (const c of children(sd[i++]!, 64)) if (c.tag === 0x30) {
      try { certificates.push(new X509Certificate(raw(c))); } catch { invalid("A certificate in the signature cannot be read."); }
    }
  }
  if (sd[i]?.tag === 0xa1) i++; // CRLs
  const signers = list(expect(sd[i], 0x31, "signer infos"), 4);
  if (signers.length !== 1) invalid("The signature must have exactly one signer.");
  const si = list(expect(signers[0], 0x30, "signer info"), 8);
  let j = 0;
  expect(si[j++], 0x02, "signer version");
  const sid = si[j++]!;
  let signer: X509Certificate | undefined;
  if (sid.tag === 0x30) {
    const [issuerEl, serialEl] = list(sid);
    const issuer = raw(issuerEl!), serial = stripZeros(value(expect(serialEl, 0x02, "serial")));
    signer = certificates.find(c => { const x = issuerAndSerial(c); return x.issuer.equals(issuer) && x.serial.equals(serial); });
  }
  if (!signer) invalid("The signer's certificate is not in the signature.");
  const digest = DIGESTS[oid(list(expect(si[j++], 0x30, "digest algorithm"))[0]!)] ?? invalid("The signature uses a digest weaker than SHA-256.");
  const attrs = expect(si[j++], 0xa0, "signed attributes");
  const sigAlg = SIGNATURES[oid(list(expect(si[j++], 0x30, "signature algorithm"))[0]!)] ?? invalid("The signature algorithm is not accepted.");
  const signature = value(expect(si[j++], 0x04, "signature"));

  let messageDigest: Buffer | undefined;
  let attrType: string | undefined;
  for (const a of children(attrs, 64)) {
    const [t, values] = list(expect(a, 0x30, "attribute"));
    const name = oid(t!);
    const first = list(expect(values, 0x31, "attribute values"))[0];
    if (name === OID.messageDigest) messageDigest = value(expect(first, 0x04, "message digest"));
    else if (name === OID.contentType) attrType = oid(first!);
  }
  if (!messageDigest || attrType !== contentType) invalid("The signed attributes are incomplete.");
  if (!createHash(digest!).update(content).digest().equals(messageDigest!)) invalid("The signed content was changed after signing.");
  // The signature covers the attributes encoded as a SET (tag 0x31), not as [0].
  const signedBytes = Buffer.from(raw(attrs));
  signedBytes[0] = 0x31;
  let ok = false;
  try { ok = verify(digest!, signedBytes, sigAlg === "ec" ? { key: signer!.publicKey, dsaEncoding: "der" } : signer!.publicKey, signature); }
  catch { ok = false; }
  if (!ok) invalid("The signature does not verify.");
  return { contentType, content, contentDer, signer: signer!, certificates };
}

/** The digest an Authenticode SpcIndirectDataContent states for the signed file. */
export function indirectDigest(contentDer: Buffer): { algorithm: string; digest: Buffer } {
  const [, digestInfo] = list(expect(read(contentDer), 0x30, "indirect data"));
  const [alg, digest] = list(expect(digestInfo, 0x30, "digest info"));
  const name = oid(list(expect(alg, 0x30, "algorithm"))[0]!);
  const algorithm = DIGESTS[name] ?? (name === "1.3.14.3.2.26" ? "sha1" : invalid("Unknown file digest algorithm."));
  return { algorithm: algorithm!, digest: value(expect(digest, 0x04, "digest")) };
}

export type { El };
