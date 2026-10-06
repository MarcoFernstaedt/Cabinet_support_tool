// Certificate signing requests in, X.509 v3 certificates out.
// The private key that signs certificates is reached only through
// IssuingKey.signTbs, so the development key can be swapped for the KMS
// (docs/spec/10-coding-agent-handoff.md milestone 2) without touching this file.
import { createHash, createPublicKey, randomBytes, verify, X509Certificate, type KeyObject } from "node:crypto";
import * as der from "./der.js";

export const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  rsaEncryption: "1.2.840.113549.1.1.1",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  rsaSha256: "1.2.840.113549.1.1.11",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  clientAuth: "1.3.6.1.5.5.7.3.2",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

/** The key that signs certificates. In production its signTbs calls the KMS; the private key never leaves it. */
export interface IssuingKey {
  /** The issuing (CA) certificate, PEM. */
  readonly certificatePem: string;
  /** Signs the DER bytes of a TBSCertificate with ECDSA P-256 / SHA-256 and returns the DER signature. */
  signTbs(tbs: Buffer): Promise<Buffer>;
}

export class CsrError extends Error {}

export interface VerifiedCsr {
  /** DER SubjectPublicKeyInfo, copied into the certificate as is. */
  spki: Buffer;
  publicKey: KeyObject;
}

/**
 * Parses a PKCS#10 request, checks its self-signature, and accepts only
 * ECDSA P-256/P-384 or RSA keys of at least 2048 bits. Everything else in
 * the request (subject, attributes) is ignored: the server decides what the
 * certificate says.
 */
export function verifyCsr(pem: string): VerifiedCsr {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, "").replace(/\s+/g, "");
  if (body.length === 0 || body.length > 12_000 || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new CsrError("not a PEM certificate request");
  let root: der.Node;
  try {
    root = der.decode(Buffer.from(body, "base64"));
    const info = der.child(root, 0, der.Tag.Sequence);
    const algorithm = der.oidToString(der.child(der.child(root, 1, der.Tag.Sequence), 0));
    const signatureBits = der.child(root, 2, der.Tag.BitString);
    if (signatureBits.value[0] !== 0) throw new CsrError("bad signature encoding");
    const spkiNode = der.child(info, 2, der.Tag.Sequence);
    let publicKey: KeyObject;
    try { publicKey = createPublicKey({ key: spkiNode.raw, format: "der", type: "spki" }); }
    catch { throw new CsrError("unreadable public key"); }
    checkKey(publicKey);
    const hash = algorithm === OID.ecdsaSha256 || algorithm === OID.rsaSha256 ? "sha256" : algorithm === OID.ecdsaSha384 ? "sha384" : null;
    if (!hash) throw new CsrError("unsupported signature algorithm");
    const ok = verify(hash, info.raw, publicKey.asymmetricKeyType === "ec" ? { key: publicKey, dsaEncoding: "der" } : publicKey, signatureBits.value.subarray(1));
    if (!ok) throw new CsrError("the request's signature does not match its key");
    return { spki: Buffer.from(spkiNode.raw), publicKey };
  } catch (e) {
    if (e instanceof CsrError) throw e;
    throw new CsrError("malformed certificate request");
  }
}

function checkKey(key: KeyObject): void {
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType === "ec" && (details?.namedCurve === "prime256v1" || details?.namedCurve === "secp384r1")) return;
  if (key.asymmetricKeyType === "rsa" && (details?.modulusLength ?? 0) >= 2048) return;
  throw new CsrError("the key must be ECDSA P-256/P-384 or RSA 2048+");
}

const name = (commonName: string, organization?: string): Buffer =>
  der.sequence(
    ...(organization ? [der.set(der.sequence(der.oid(OID.organization), der.utf8(organization)))] : []),
    der.set(der.sequence(der.oid(OID.commonName), der.utf8(commonName))),
  );

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  der.sequence(der.oid(id), ...(critical ? [der.boolean(true)] : []), der.octetString(value));

/** The key identifier: SHA-1 of the subjectPublicKey bits (RFC 5280 method 1). */
export function keyIdentifier(spki: Buffer): Buffer {
  const bits = der.child(der.decode(spki), 1, der.Tag.BitString).value.subarray(1);
  return createHash("sha1").update(bits).digest();
}

export interface CertificateProfile {
  kind: "agent" | "server" | "ca";
  commonName: string;
  organization?: string;
  /** dNSName entries (server), or a URI (agent). */
  dnsNames?: string[];
  ipAddresses?: string[];
  uri?: string;
  notBefore: Date;
  notAfter: Date;
}

export interface IssuedCertificate {
  pem: string;
  serialHex: string;
  notAfter: Date;
}

/**
 * Builds and signs one certificate. issuerSpki and issuerName are taken from
 * the issuing certificate, or from the subject itself for a self-signed CA.
 */
export async function issue(
  profile: CertificateProfile,
  subjectSpki: Buffer,
  signer: (tbs: Buffer) => Promise<Buffer>,
  issuer: { name: Buffer; spki: Buffer },
): Promise<IssuedCertificate> {
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f; // positive
  if (serial[0] === 0) serial[0] = 0x01;
  const algorithm = der.sequence(der.oid(OID.ecdsaSha256));
  const subject = name(profile.commonName, profile.organization);
  const extensions: Buffer[] = [];
  if (profile.kind === "ca") {
    extensions.push(extension(OID.basicConstraints, true, der.sequence(der.boolean(true), der.integer(0))));
    extensions.push(extension(OID.keyUsage, true, der.bitString(Buffer.from([0x06]), 1))); // keyCertSign, cRLSign
  } else {
    extensions.push(extension(OID.basicConstraints, true, der.sequence()));
    extensions.push(extension(OID.keyUsage, true, der.bitString(Buffer.from([0x80]), 7))); // digitalSignature
    extensions.push(extension(OID.extKeyUsage, false, der.sequence(der.oid(profile.kind === "agent" ? OID.clientAuth : OID.serverAuth))));
    const names: Buffer[] = [
      ...(profile.dnsNames ?? []).map(n => der.context(2, Buffer.from(n, "ascii"), false)),
      ...(profile.ipAddresses ?? []).map(ip => der.context(7, Buffer.from(ip.split(".").map(Number)), false)),
      ...(profile.uri ? [der.context(6, Buffer.from(profile.uri, "ascii"), false)] : []),
    ];
    if (names.length > 0) extensions.push(extension(OID.subjectAltName, false, der.sequence(...names)));
  }
  extensions.push(extension(OID.subjectKeyId, false, der.octetString(keyIdentifier(subjectSpki))));
  extensions.push(extension(OID.authorityKeyId, false, der.sequence(der.context(0, keyIdentifier(issuer.spki), false))));

  const tbs = der.sequence(
    der.context(0, der.integer(2)),
    der.integer(serial),
    algorithm,
    profile.kind === "ca" ? subject : issuer.name,
    der.sequence(der.time(profile.notBefore), der.time(profile.notAfter)),
    subject,
    subjectSpki,
    der.context(3, der.sequence(...extensions)),
  );
  const signature = await signer(tbs);
  const certificate = der.sequence(tbs, algorithm, der.bitString(signature));
  const pem = toPem(certificate, "CERTIFICATE");
  // Parse it back with Node's own X.509 reader as a final structural check.
  const parsed = new X509Certificate(pem);
  return { pem, serialHex: parsed.serialNumber.toUpperCase(), notAfter: new Date(parsed.validTo) };
}

export function toPem(derBytes: Buffer, label: string): string {
  const b64 = derBytes.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** The issuer Name and SubjectPublicKeyInfo of a certificate, for issuing under it. */
export function issuerOf(certificatePem: string): { name: Buffer; spki: Buffer } {
  const parsed = new X509Certificate(certificatePem);
  const tbs = der.child(der.decode(parsed.raw), 0, der.Tag.Sequence);
  return { name: Buffer.from(der.child(tbs, 5, der.Tag.Sequence).raw), spki: Buffer.from(der.child(tbs, 6, der.Tag.Sequence).raw) };
}
