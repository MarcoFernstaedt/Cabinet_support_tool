// A reader for Compound File Binary files (the container an MSI is), enough to walk its storages
// and read its streams. Bounded: chains are checked for loops and lengths, and nothing is trusted.
import { PackageRefused } from "./asn1.js";

const ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff, NOSTREAM = 0xffffffff;
// A file that is not a well-formed compound file is not an installer at all, so it is refused as unverifiable, not as a bad signature:
// signature_invalid is kept for a real installer whose signature does not hold.
const bad = (m: string): never => { throw new PackageRefused("verification_failed", `The installer file is damaged (${m}).`); };

export interface Entry { id: number; name: Buffer; type: number; clsid: Buffer; child: number; left: number; right: number; start: number; size: number; }

export class CompoundFile {
  readonly entries: Entry[] = [];
  private readonly sectorSize: number;
  private readonly fat: number[] = [];
  private readonly miniFat: number[] = [];
  private readonly miniStream: Buffer;
  private readonly miniCutoff: number;

  constructor(private readonly buf: Buffer) {
    if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1)
      throw new PackageRefused("verification_failed", "The file is not an MSI installer.");
    const shift = buf.readUInt16LE(0x1e);
    if (shift !== 9 && shift !== 12) bad("sector size");
    this.sectorSize = 1 << shift;
    if (buf.readUInt16LE(0x20) !== 6) bad("mini sector size");
    this.miniCutoff = buf.readUInt32LE(0x38);
    const fatSectors = buf.readUInt32LE(0x2c);
    const sectors = Math.floor((buf.length - this.sectorSize) / this.sectorSize) + 1;
    if (fatSectors > sectors) bad("FAT size");
    // The FAT's own sectors are listed in the header (109) and then in the DIFAT chain.
    const fatList: number[] = [];
    for (let i = 0; i < 109 && fatList.length < fatSectors; i++) fatList.push(buf.readUInt32LE(0x4c + i * 4));
    let difat = buf.readUInt32LE(0x44);
    const perDifat = this.sectorSize / 4 - 1;
    for (let guard = 0; fatList.length < fatSectors && difat !== ENDOFCHAIN && difat !== FREESECT; guard++) {
      if (guard > sectors) bad("DIFAT loop");
      const at = this.offset(difat);
      for (let i = 0; i < perDifat && fatList.length < fatSectors; i++) fatList.push(buf.readUInt32LE(at + i * 4));
      difat = buf.readUInt32LE(at + perDifat * 4);
    }
    if (fatList.length !== fatSectors) bad("FAT list");
    for (const s of fatList) { const at = this.offset(s); for (let i = 0; i < this.sectorSize / 4; i++) this.fat.push(this.buf.readUInt32LE(at + i * 4)); }
    const miniFatData = this.chain(buf.readUInt32LE(0x3c), Number.MAX_SAFE_INTEGER, true);
    for (let i = 0; i + 4 <= miniFatData.length; i += 4) this.miniFat.push(miniFatData.readUInt32LE(i));
    const dir = this.chain(buf.readUInt32LE(0x30), Number.MAX_SAFE_INTEGER, true);
    if (dir.length / 128 > 100_000) bad("too many entries");
    for (let i = 0; i + 128 <= dir.length; i += 128) {
      const nameLen = dir.readUInt16LE(i + 0x40);
      this.entries.push({
        id: i / 128, name: dir.subarray(i, i + Math.min(nameLen, 64)), type: dir[i + 0x42]!, clsid: dir.subarray(i + 0x50, i + 0x60),
        left: dir.readUInt32LE(i + 0x44), right: dir.readUInt32LE(i + 0x48), child: dir.readUInt32LE(i + 0x4c),
        start: dir.readUInt32LE(i + 0x74), size: this.sectorSize === 512 ? dir.readUInt32LE(i + 0x78) : Number(dir.readBigUInt64LE(i + 0x78)),
      });
    }
    const root = this.entries[0];
    if (!root || root.type !== 5) bad("no root storage");
    this.miniStream = this.chain(root!.start, root!.size, false);
  }

  private offset(sector: number): number {
    const at = (sector + 1) * this.sectorSize;
    if (sector >= 0xfffffffa || at + this.sectorSize > this.buf.length) bad("sector out of range");
    return at;
  }

  private chain(start: number, size: number, wholeChain: boolean): Buffer {
    const parts: Buffer[] = [];
    let total = 0;
    const seen = new Set<number>();
    for (let s = start; s !== ENDOFCHAIN && (wholeChain || total < size); s = this.fat[s] ?? bad("broken chain")) {
      if (s === FREESECT && wholeChain) break;
      if (seen.has(s)) bad("chain loop");
      seen.add(s);
      const at = this.offset(s);
      parts.push(this.buf.subarray(at, at + this.sectorSize));
      total += this.sectorSize;
    }
    const all = Buffer.concat(parts);
    if (!wholeChain && all.length < size) bad("stream shorter than stated");
    return wholeChain ? all : all.subarray(0, size);
  }

  /** A stream's bytes (from the mini stream when it is small). */
  read(e: Entry): Buffer {
    if (e.size === 0) return Buffer.alloc(0);
    if (e.size > 512 * 1024 * 1024) bad("stream too large");
    if (e.size >= this.miniCutoff) return this.chain(e.start, e.size, false);
    const parts: Buffer[] = [];
    let total = 0;
    const seen = new Set<number>();
    for (let s = e.start; total < e.size; s = this.miniFat[s] ?? bad("broken mini chain")) {
      if (s === ENDOFCHAIN || seen.has(s)) bad("mini chain");
      seen.add(s);
      const at = s * 64;
      if (at + 64 > this.miniStream.length) bad("mini sector out of range");
      parts.push(this.miniStream.subarray(at, at + 64));
      total += 64;
    }
    return Buffer.concat(parts).subarray(0, e.size);
  }

  /** The entries directly inside a storage (its red-black tree, walked without recursion limits being trusted). */
  childrenOf(storage: Entry): Entry[] {
    const out: Entry[] = [];
    const stack = [storage.child];
    const seen = new Set<number>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === NOSTREAM) continue;
      if (seen.has(id) || id >= this.entries.length) bad("directory tree");
      seen.add(id);
      const e = this.entries[id]!;
      out.push(e);
      stack.push(e.left, e.right);
    }
    return out;
  }
}
