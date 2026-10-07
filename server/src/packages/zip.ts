// A small zip reader for driver packages: central directory only, stored or deflated entries, no
// encryption or zip64, plain relative names, sizes checked against what actually inflates.
import { crc32, inflateRawSync } from "node:zlib";
import { PackageRefused } from "./asn1.js";

export interface ZipEntry { name: string; data: Buffer; }
export const MAX_ENTRIES = 2000;
export const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
export const MAX_ENTRY = 512 * 1024 * 1024;

const refuse = (m: string): never => { throw new PackageRefused("verification_failed", m); };

/** Plain relative names only: no drive, root, "..", control or reserved characters (same rule as the agent). */
export function safeName(name: string): boolean {
  if (name.length === 0 || name.length > 240 || name.startsWith("/")) return false;
  for (const part of name.split("/")) {
    if (part.length === 0 || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ")) return false;
    for (const ch of part) { const c = ch.charCodeAt(0); if (c < 0x20 || c === 0x7f || ':*?"<>|'.includes(ch)) return false; }
    const stem = part.split(".")[0]!.toUpperCase();
    if (["CON", "PRN", "AUX", "NUL"].includes(stem) || (stem.length === 4 && (stem.startsWith("COM") || stem.startsWith("LPT")) && stem[3]! >= "0" && stem[3]! <= "9")) return false;
  }
  return true;
}

export function readZip(buf: Buffer, limits = { entry: MAX_ENTRY, total: MAX_TOTAL }): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) refuse("The package is not a valid zip file.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) refuse("The package uses zip64, which is not allowed.");
  if (count > MAX_ENTRIES) refuse("The package has too many files.");
  if (cdOffset + cdSize > eocd) refuse("The package's directory is damaged.");
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) refuse("The package's directory is damaged.");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString((flags & 0x800) !== 0 ? "utf8" : "latin1").replace(/\\/g, "/");
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue; // a folder
    if ((flags & 0x1) !== 0) refuse("The package uses zip encryption, which is not allowed.");
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) refuse("The package uses zip64, which is not allowed.");
    if (!safeName(name)) refuse("The package contains a file name that is not allowed.");
    if (seen.has(name.toLowerCase())) refuse("The package contains the same file twice.");
    seen.add(name.toLowerCase());
    if (usize > limits.entry || (total += usize) > limits.total) refuse("The package unpacks to more than is allowed.");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) refuse("The package's file headers are damaged.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) refuse("The package is truncated.");
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }); } catch { refuse("A file in the package does not unpack (damaged, or larger than it claims)."); }
    } else refuse("The package uses a compression method that is not allowed.");
    if (data!.length !== usize || crc32(data!) !== crc) refuse("A file in the package is damaged.");
    out.push({ name, data: data! });
  }
  return out;
}
