// MSI installers on the server: the Authenticode signature in the \u0005DigitalSignature stream must
// verify, its stated digest must equal the hash of the installer's contents, and the signer must be a
// trusted MSI publisher. The hash follows the established algorithm (as osslsigncode computes it): every
// stream's bytes, storages recursively, children in name order, each storage's class ID last.
import { createHash, type Hash } from "node:crypto";
import { PackageRefused } from "./asn1.js";
import { CompoundFile, type Entry } from "./cfb.js";
import { indirectDigest, OID, verifySignedData } from "./signed-data.js";
import type { Publisher, TrustList } from "./trust.js";

const name = (s: string): Buffer => Buffer.from(s + "\0", "utf16le");
const SIGNATURE = name("\u0005DigitalSignature");
const SIGNATURE_EX = name("\u0005MsiDigitalSignatureEx");

/** Name order: bytewise on the UTF-16 names (terminator included); on a tie the longer sorts last. */
function compare(a: Entry, b: Entry): number {
  const n = Math.min(a.name.length, b.name.length);
  const d = Buffer.compare(a.name.subarray(0, n), b.name.subarray(0, n));
  return d !== 0 ? d : a.name.length > b.name.length ? 1 : -1;
}

function hashStorage(cfb: CompoundFile, storage: Entry, h: Hash, root: boolean, depth: number): void {
  if (depth > 32) throw new PackageRefused("signature_invalid", "The installer's storages are nested too deeply.");
  for (const child of cfb.childrenOf(storage).sort(compare)) {
    if (root && (child.name.equals(SIGNATURE) || child.name.equals(SIGNATURE_EX))) continue;
    if (child.type === 2) h.update(cfb.read(child));
    else if (child.type === 1) hashStorage(cfb, child, h, false, depth + 1);
  }
  h.update(storage.clsid);
}

export function checkMsi(file: Buffer, trust: TrustList): { signer: Publisher } {
  const cfb = new CompoundFile(file);
  const root = cfb.entries[0]!;
  const top = cfb.childrenOf(root);
  const sigEntry = top.find(e => e.name.equals(SIGNATURE));
  if (!sigEntry) throw new PackageRefused("signature_invalid", "The installer is not signed.");
  const signed = verifySignedData(cfb.read(sigEntry));
  if (signed.contentType !== OID.spcIndirectData) throw new PackageRefused("signature_invalid", "The installer's signature is not an Authenticode signature.");
  const { algorithm, digest } = indirectDigest(signed.contentDer);
  const h = createHash(algorithm);
  const ex = top.find(e => e.name.equals(SIGNATURE_EX));
  if (ex) h.update(cfb.read(ex)); // the extended signature's pre-hash comes first (it is checked again by Windows on the cabinet)
  hashStorage(cfb, root, h, true, 0);
  if (!h.digest().equals(digest)) throw new PackageRefused("signature_invalid", "The installer was changed after it was signed.");
  const publisher = trust.match(signed.signer, signed.certificates, "msi");
  if (!publisher) throw new PackageRefused("publisher_not_trusted", "The installer's signer is not a trusted publisher.");
  return { signer: publisher };
}
