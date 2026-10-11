// Minimal DER (ASN.1 Distinguished Encoding Rules) encoder and decoder.
// Only what certificate issuing needs. The decoder reads untrusted input
// (certificate signing requests from the internet), so every length is
// bounds-checked, indefinite lengths are refused and nesting is limited.

export const Tag = {
  Boolean: 0x01, Integer: 0x02, BitString: 0x03, OctetString: 0x04, Null: 0x05, Oid: 0x06,
  Utf8String: 0x0c, PrintableString: 0x13, Ia5String: 0x16, UtcTime: 0x17, GeneralizedTime: 0x18,
  Sequence: 0x30, Set: 0x31,
} as const;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

export const sequence = (...items: Buffer[]): Buffer => tlv(Tag.Sequence, Buffer.concat(items));
export const set = (...items: Buffer[]): Buffer => tlv(Tag.Set, Buffer.concat(items));
export const nullValue = (): Buffer => tlv(Tag.Null, Buffer.alloc(0));
export const boolean = (v: boolean): Buffer => tlv(Tag.Boolean, Buffer.from([v ? 0xff : 0x00]));
export const octetString = (b: Buffer): Buffer => tlv(Tag.OctetString, b);
export const utf8 = (s: string): Buffer => tlv(Tag.Utf8String, Buffer.from(s, "utf8"));
/** BIT STRING with the given number of unused bits in the last byte. */
export const bitString = (b: Buffer, unusedBits = 0): Buffer => tlv(Tag.BitString, Buffer.concat([Buffer.from([unusedBits]), b]));
/** Context-specific tag [n]: constructed (explicit) or primitive (implicit). */
export const context = (n: number, content: Buffer, constructed = true): Buffer => tlv((constructed ? 0xa0 : 0x80) | n, content);

/** A non-negative INTEGER from big-endian bytes or a small number. */
export function integer(value: Buffer | number): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    const hex = value.toString(16);
    bytes = Buffer.from(hex.length % 2 === 0 ? hex : "0" + hex, "hex");
  } else bytes = value;
  if (bytes.length === 0) bytes = Buffer.from([0]);
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1]! & 0x80) === 0) start++;
  bytes = bytes.subarray(start);
  if ((bytes[0]! & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(Tag.Integer, bytes);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(p => {
    if (!/^\d+$/.test(p)) throw new Error("bad OID");
    return BigInt(p);
  });
  if (parts.length < 2) throw new Error("bad OID");
  const out: number[] = [];
  const encode = (v: bigint): void => {
    const chunk: number[] = [Number(v & 0x7fn)];
    for (v >>= 7n; v > 0n; v >>= 7n) chunk.unshift(Number(v & 0x7fn) | 0x80);
    out.push(...chunk);
  };
  encode(parts[0]! * 40n + parts[1]!);
  for (const p of parts.slice(2)) encode(p);
  return tlv(Tag.Oid, Buffer.from(out));
}

/** UTCTime before 2050, GeneralizedTime after, as RFC 5280 requires. Second precision, Z. */
export function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  return date.getUTCFullYear() < 2050
    ? tlv(Tag.UtcTime, Buffer.from(iso.slice(2) + "Z", "ascii"))
    : tlv(Tag.GeneralizedTime, Buffer.from(iso + "Z", "ascii"));
}

// ---- Decoding -------------------------------------------------------------

export interface Node {
  tag: number;
  constructed: boolean;
  /** The content octets. */
  value: Buffer;
  /** The whole element, header included (needed to verify signatures over it). */
  raw: Buffer;
  children: Node[];
}

export class DerError extends Error {}

const MAX_DEPTH = 16;

export function decode(input: Buffer, depth = 0): Node {
  const [node, used] = decodeAt(input, 0, depth);
  if (used !== input.length) throw new DerError("trailing bytes after DER element");
  return node;
}

function decodeAt(buf: Buffer, offset: number, depth: number): [Node, number] {
  if (depth > MAX_DEPTH) throw new DerError("DER nested too deeply");
  if (offset + 2 > buf.length) throw new DerError("truncated DER header");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte tags are not supported");
  let len = buf[offset + 1]!;
  let header = 2;
  if (len === 0x80) throw new DerError("indefinite length is not DER");
  if (len > 0x80) {
    const count = len & 0x7f;
    if (count > 4 || offset + 2 + count > buf.length) throw new DerError("bad DER length");
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[offset + 2 + i]!;
    header += count;
  }
  const start = offset + header;
  const end = start + len;
  if (end > buf.length) throw new DerError("DER length runs past the input");
  const value = buf.subarray(start, end);
  const constructed = (tag & 0x20) !== 0;
  const children: Node[] = [];
  if (constructed) {
    let pos = 0;
    while (pos < value.length) {
      const [child, used] = decodeAt(value, pos, depth + 1);
      children.push(child);
      pos += used;
      if (children.length > 1024) throw new DerError("too many DER elements");
    }
  }
  return [{ tag, constructed, value, raw: buf.subarray(offset, end), children }, header + len];
}

export function oidToString(node: Node): string {
  if (node.tag !== Tag.Oid || node.value.length === 0 || node.value.length > 64) throw new DerError("expected OID");
  const parts: bigint[] = [];
  let v = 0n;
  for (const b of node.value) {
    v = (v << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) { parts.push(v); v = 0n; }
  }
  if ((node.value[node.value.length - 1]! & 0x80) !== 0) throw new DerError("truncated OID");
  const first = parts.shift()!;
  const a = first < 80n ? first / 40n : 2n;
  return [a, first - a * 40n, ...parts].join(".");
}

export function child(node: Node, index: number, tag?: number): Node {
  const c = node.children[index];
  if (!c || (tag !== undefined && c.tag !== tag)) throw new DerError("unexpected DER structure");
  return c;
}
