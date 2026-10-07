// Driver packages on the server: the same checks the agent repeats on the cabinet
// (agent/src/Cabinet.Agent.Core/Packages/DriverPackage.cs). Every INF names a catalog in the package;
// each catalog's signature verifies and its signer is a trusted driver publisher; every other file is
// a member of one of those catalogs.
import { children, expect, oid, PackageRefused, read, value } from "./asn1.js";
import { fileDigests } from "./pe.js";
import { OID, verifySignedData, type Signed } from "./signed-data.js";
import type { Publisher, TrustList } from "./trust.js";
import { readZip, type ZipEntry } from "./zip.js";

/** The catalog files an INF names in its [Version] section (CatalogFile, or a platform-specific CatalogFile.NTxxx). */
export function catalogFilesOf(inf: Buffer): string[] {
  const text = inf.length >= 2 && inf[0] === 0xff && inf[1] === 0xfe ? inf.subarray(2).toString("utf16le")
    : inf.length >= 3 && inf[0] === 0xef && inf[1] === 0xbb && inf[2] === 0xbf ? inf.subarray(3).toString("utf8") : inf.toString("latin1");
  const found: string[] = [];
  let inVersion = false;
  for (const rawLine of text.split("\n")) {
    let quoted = false, cut = rawLine.length;
    for (let i = 0; i < rawLine.length; i++) { if (rawLine[i] === '"') quoted = !quoted; else if (rawLine[i] === ";" && !quoted) { cut = i; break; } }
    const line = rawLine.slice(0, cut).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) { inVersion = line.slice(1, -1).trim().toLowerCase() === "version"; continue; }
    if (!inVersion) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (key !== "catalogfile" && !key.startsWith("catalogfile.")) continue;
    const v = line.slice(eq + 1).trim().replace(/^"|"$/g, "").trim();
    if (v) found.push(v);
  }
  return found;
}

/** A catalog's member digests (lower-case hex), from every SPC_INDIRECT_DATA attribute in its trust list. */
export function catalogMembers(signed: Signed): Set<string> {
  if (signed.contentType !== OID.ctl) throw new PackageRefused("signature_invalid", "The catalog is not a certificate trust list.");
  const members = new Set<string>();
  const ctl = expect(read(signed.contentDer), 0x30, "trust list");
  for (const top of children(ctl, 64)) {
    if (top.tag !== 0x30) continue;
    for (const subject of children(top)) {
      if (subject.tag !== 0x30) continue;
      const parts = [...children(subject, 8)];
      if (parts[0]?.tag !== 0x04 || parts[1]?.tag !== 0x31) continue;
      for (const attr of children(parts[1], 64)) {
        const [t, values] = [...children(expect(attr, 0x30, "attribute"), 4)];
        if (oid(t!) !== OID.spcIndirectData) continue;
        const indirect = [...children(expect([...children(values!, 4)][0], 0x30, "indirect data"), 4)];
        const digestInfo = [...children(expect(indirect[1], 0x30, "digest info"), 4)];
        members.add(value(expect(digestInfo[1], 0x04, "digest")).toString("hex"));
      }
    }
  }
  return members;
}

export interface DriverCheck { signer: Publisher; infs: string[]; files: number; }

export function checkDriverPackage(zip: Buffer, trust: TrustList): DriverCheck {
  const entries = readZip(zip);
  const byName = new Map(entries.map(e => [e.name.toLowerCase(), e] as const));
  const infs = entries.filter(e => e.name.toLowerCase().endsWith(".inf"));
  if (infs.length === 0) throw new PackageRefused("verification_failed", "The package has no INF file.");
  const catalogs = new Map<string, Set<string>>();
  let signer: Publisher | null = null;
  for (const inf of infs) {
    const dir = inf.name.includes("/") ? inf.name.slice(0, inf.name.lastIndexOf("/") + 1) : "";
    const names = catalogFilesOf(inf.data);
    if (names.length === 0) throw new PackageRefused("signature_invalid", `${inf.name} does not name a signed catalog.`);
    for (const cat of names) {
      const entry: ZipEntry | undefined = byName.get((dir + cat.replace(/\\/g, "/")).toLowerCase());
      if (!entry) throw new PackageRefused("signature_invalid", `The catalog ${cat} named by ${inf.name} is not in the package.`);
      if (catalogs.has(entry.name.toLowerCase())) continue;
      const signed = verifySignedData(entry.data);
      const members = catalogMembers(signed);
      const publisher = trust.match(signed.signer, signed.certificates, "driver");
      if (!publisher) throw new PackageRefused("publisher_not_trusted", `The catalog is signed by "${signed.signer.subject.split("\n").find(l => l.startsWith("CN="))?.slice(3) ?? "unknown"}", which is not a trusted publisher.`);
      signer ??= publisher;
      catalogs.set(entry.name.toLowerCase(), members);
    }
  }
  for (const e of entries) {
    if (catalogs.has(e.name.toLowerCase())) continue;
    const digests = fileDigests(e.data);
    if (![...catalogs.values()].some(m => digests.some(d => m.has(d))))
      throw new PackageRefused("signature_invalid", `${e.name} is not covered by the package's signed catalog (it may have been changed).`);
  }
  return { signer: signer!, infs: infs.map(i => i.name), files: entries.length };
}
