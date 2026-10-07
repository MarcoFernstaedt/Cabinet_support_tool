// The parts of a Windows executable its Authenticode hash covers (same rule as the agent):
// everything except the header checksum, the certificate-table directory entry and the table itself.
import { createHash } from "node:crypto";

export function authenticodeRanges(f: Buffer): [number, number][] | null {
  if (f.length < 0x40 || f[0] !== 0x4d || f[1] !== 0x5a) return null;
  const pe = f.readInt32LE(0x3c);
  if (pe < 0x40 || pe > f.length - 24 || f.readUInt32LE(pe) !== 0x00004550) return null;
  const optional = pe + 24;
  if (optional + 2 > f.length) return null;
  const magic = f.readUInt16LE(optional);
  const certDir = magic === 0x10b ? optional + 128 : magic === 0x20b ? optional + 144 : -1;
  if (certDir < 0 || certDir + 8 > f.length) return null;
  const checksum = optional + 64;
  const certOffset = f.readUInt32LE(certDir), certSize = f.readUInt32LE(certDir + 4);
  const ranges: [number, number][] = [[0, checksum], [checksum + 4, certDir]];
  if (certSize === 0) ranges.push([certDir + 8, f.length]);
  else {
    if (certOffset < certDir + 8 || certOffset + certSize > f.length) return null;
    ranges.push([certDir + 8, certOffset]);
    if (certOffset + certSize < f.length) ranges.push([certOffset + certSize, f.length]);
  }
  return ranges;
}

/** Every digest a catalog may list for this file: Authenticode hashes for executables, then plain hashes; SHA-256 and SHA-1. */
export function fileDigests(f: Buffer): string[] {
  const out: string[] = [];
  const ranges = authenticodeRanges(f);
  for (const alg of ["sha256", "sha1"]) {
    if (ranges) { const h = createHash(alg); for (const [a, b] of ranges) h.update(f.subarray(a, b)); out.push(h.digest("hex")); }
    out.push(createHash(alg).update(f).digest("hex"));
  }
  return out;
}
