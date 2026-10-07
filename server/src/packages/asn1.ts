// A bounded, lazy DER reader for package signatures. Catalogs can list thousands of files, so
// children are read on demand instead of all at once, with limits on depth, element count and length.

export class PackageRefused extends Error {
  constructor(readonly code: "hash_mismatch" | "signature_invalid" | "publisher_not_trusted" | "verification_failed", message: string) { super(message); }
}

export interface El { tag: number; constructed: boolean; start: number; valueStart: number; end: number; buf: Buffer; }

const bad = (why: string): never => { throw new PackageRefused("signature_invalid", `The signature is malformed (${why}).`); };

export function read(buf: Buffer, offset = 0, limit = buf.length): El {
  if (offset + 2 > limit) bad("truncated header");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) bad("multi-byte tag");
  let len = buf[offset + 1]!;
  let header = 2;
  if (len === 0x80) bad("indefinite length");
  if (len > 0x80) {
    const n = len & 0x7f;
    if (n > 4 || offset + 2 + n > limit) bad("bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i]!;
    header += n;
  }
  const end = offset + header + len;
  if (end > limit) bad("length past end");
  return { tag, constructed: (tag & 0x20) !== 0, start: offset, valueStart: offset + header, end, buf };
}

export const value = (e: El): Buffer => e.buf.subarray(e.valueStart, e.end);
export const raw = (e: El): Buffer => e.buf.subarray(e.start, e.end);

/** The children of a constructed element, read one at a time. */
export function* children(e: El, max = 200_000): Generator<El> {
  if (!e.constructed) bad("expected a constructed element");
  let pos = e.valueStart;
  let n = 0;
  while (pos < e.end) {
    const c = read(e.buf, pos, e.end);
    yield c;
    pos = c.end;
    if (++n > max) bad("too many elements");
  }
}

export function list(e: El, max = 64): El[] {
  const out: El[] = [];
  for (const c of children(e, max)) out.push(c);
  return out;
}

export function oid(e: El): string {
  if (e.tag !== 0x06) bad("expected an object identifier");
  const v = value(e);
  if (v.length === 0 || v.length > 64) bad("bad object identifier");
  const parts: number[] = [];
  let acc = 0;
  for (const b of v) {
    acc = acc * 128 + (b & 0x7f);
    if (acc > Number.MAX_SAFE_INTEGER / 256) bad("object identifier too long");
    if ((b & 0x80) === 0) { parts.push(acc); acc = 0; }
  }
  if ((v[v.length - 1]! & 0x80) !== 0) bad("truncated object identifier");
  const first = parts.shift()!;
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...parts].join(".");
}

export function expect(e: El | undefined, tag: number, what: string): El {
  if (!e || e.tag !== tag) bad(`expected ${what}`);
  return e!;
}
