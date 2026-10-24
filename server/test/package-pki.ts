// Test material for the software library: a small PKI, PKCS #7 signing, catalogs, zips and a
// compound-file (MSI) writer. Real Microsoft-signed files are checked on the Windows CI runner.
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import * as der from "../src/pki/der.js";
import { fileDigests } from "../src/packages/pe.js";
import { OID } from "../src/packages/signed-data.js";
import { read, value } from "../src/packages/asn1.js";
import { tempDir } from "./helpers.js";

export interface Identity { cert: X509Certificate; key: KeyObject; name: Buffer; spki: Buffer; }

const nameOf = (cn: string, o: string): Buffer =>
  der.sequence(der.set(der.sequence(der.oid("2.5.4.3"), der.utf8(cn))), der.set(der.sequence(der.oid("2.5.4.10"), der.utf8(o))));

export function identity(cn: string, o: string, issuer: Identity | null, ca: boolean, validity = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 365 * 86_400_000) }): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const name = nameOf(cn, o);
  const serial = randomBytes(12); serial[0] = (serial[0]! & 0x7f) | 0x01;
  const alg = der.sequence(der.oid("1.2.840.10045.4.3.2"));
  const ext = ca ? [der.context(3, der.sequence(
    der.sequence(der.oid("2.5.29.19"), der.boolean(true), der.octetString(der.sequence(der.boolean(true)))),
  ))] : [];
  const tbs = der.sequence(der.context(0, der.integer(2)), der.integer(serial), alg, issuer?.name ?? name,
    der.sequence(der.time(validity.from), der.time(validity.to)), name, spki, ...ext);
  const signature = sign("sha256", tbs, issuer?.key ?? privateKey);
  const cert = new X509Certificate(der.sequence(tbs, alg, der.bitString(signature)));
  return { cert, key: privateKey, name, spki };
}

export class TestPki {
  readonly root = identity("Test Root CA", "Test PKI", null, true);
  readonly intermediate = identity("Test Code Signing CA", "Test PKI", this.root, true);
  readonly otherRoot = identity("Test Root CA", "Test PKI", null, true); // same name, different key

  signer(cn: string, o: string, issuer: Identity = this.intermediate, validity?: { from: Date; to: Date }): Identity { return identity(cn, o, issuer, false, validity); }

  /** A trusted-publisher folder like contracts/trust, trusting this PKI's root. */
  trustFolder(publishers: { cn: string; o: string; types: ("driver" | "msi")[] }[]): string {
    const dir = tempDir();
    const sha = createHash("sha256").update(this.root.cert.raw).digest("hex");
    writeFileSync(join(dir, "test-root.pem"), this.root.cert.toString());
    writeFileSync(join(dir, "trusted-publishers.json"), JSON.stringify({
      version: 1, roots: [{ name: "Test Root CA", sha256: sha, file: "test-root.pem" }],
      publishers: publishers.map(p => ({ name: p.cn, commonName: p.cn, organization: p.o, root: sha, packageTypes: p.types, reason: "test" })),
    }));
    return dir;
  }

  /** PKCS #7 SignedData over content (carried directly, as Windows does, or wrapped in an OCTET STRING). */
  sign(contentDer: Buffer, contentType: string, by: Identity, opts: { wrapped?: boolean; digest?: "sha256" | "sha1"; tamper?: (c: Buffer) => Buffer; chain?: Identity[] } = {}): Buffer {
    const digestAlg = opts.digest ?? "sha256";
    const digestOid = digestAlg === "sha1" ? "1.3.14.3.2.26" : "2.16.840.1.101.3.4.2.1";
    const signedValue = opts.wrapped ? contentDer : value(read(contentDer));
    const attrs = der.set(
      der.sequence(der.oid("1.2.840.113549.1.9.3"), der.set(der.oid(contentType))),
      der.sequence(der.oid("1.2.840.113549.1.9.4"), der.set(der.octetString(createHash(digestAlg).update(signedValue).digest()))),
    );
    const signature = sign(digestAlg, attrs, by.key);
    const implicitAttrs = Buffer.from(attrs); implicitAttrs[0] = 0xa0;
    const content = opts.tamper ? opts.tamper(contentDer) : contentDer;
    const tbs = der.decode(by.cert.raw).children[0]!;
    const serial = tbs.children[1]!.raw;
    const issuer = tbs.children[3]!.raw;
    const certs = [by, ...(opts.chain ?? [this.intermediate])].map(i => i.cert.raw);
    return der.sequence(der.oid(OID.signedData), der.context(0, der.sequence(
      der.integer(1),
      der.set(der.sequence(der.oid(digestOid), der.nullValue())),
      der.sequence(der.oid(contentType), der.context(0, opts.wrapped ? der.octetString(content) : content)),
      der.context(0, Buffer.concat(certs)),
      der.set(der.sequence(der.integer(1), der.sequence(issuer, serial), der.sequence(der.oid(digestOid), der.nullValue()), implicitAttrs,
        der.sequence(der.oid("1.2.840.10045.2.1")), der.octetString(signature))),
    )));
  }

  /** A driver catalog listing these files' digests, signed. */
  catalog(by: Identity, files: Buffer[], opts: Parameters<TestPki["sign"]>[3] = {}): Buffer {
    return this.sign(ctl(files.map(f => Buffer.from(fileDigests(f)[0]!, "hex"))), OID.ctl, by, opts);
  }
}

export function ctl(digests: Buffer[]): Buffer {
  const member = (d: Buffer) => der.sequence(
    der.octetString(Buffer.from(d.toString("hex").toUpperCase(), "utf16le")),
    der.set(der.sequence(der.oid(OID.spcIndirectData), der.set(der.sequence(
      der.sequence(der.oid("1.3.6.1.4.1.311.2.1.25")),
      der.sequence(der.sequence(der.oid(d.length === 20 ? "1.3.14.3.2.26" : "2.16.840.1.101.3.4.2.1"), der.nullValue()), der.octetString(d)),
    )))));
  return der.sequence(der.sequence(der.oid("1.3.6.1.4.1.311.12.1.1")), der.octetString(randomBytes(16)), der.time(new Date()),
    der.sequence(der.oid("1.3.6.1.4.1.311.12.1.2"), der.nullValue()), der.sequence(...digests.map(member)));
}

/** A minimal Windows executable: just enough headers for the Authenticode hash, and a real machine word so the architecture
 *  of a package can be read out of its programs. The optional-header magic follows the machine, as it does in a real file. */
export function pe(body: string, machine = 0x8664): Buffer {
  const b = Buffer.alloc(0x200);
  b.write("MZ", 0, "ascii");
  b.writeInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  b.writeUInt16LE(machine, 0x84);
  b.writeUInt16LE(240, 0x94);
  b.writeUInt16LE(machine === 0x14c ? 0x10b : 0x20b, 0x98);
  return Buffer.concat([b, Buffer.from(body)]);
}

/** A zip with entries (names as given, so hostile names can be tested); deflated entries exercise a reader's inflate. */
export function zip(files: [string, Buffer][], deflate = false): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const body = deflate ? deflateRawSync(data) : data;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt16LE(deflate ? 8 : 0, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, body); central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

/** A compound file (version 3) with small streams in its root storage and one sub-storage, laid out simply. */
export function compoundFile(streams: [string, Buffer][], sub: [string, [string, Buffer][]] | null = null): Buffer {
  type E = { name: string; type: number; data?: Buffer; children?: number[] };
  const entries: E[] = [{ name: "Root Entry", type: 5, children: [] }];
  for (const [name, data] of streams) { entries[0]!.children!.push(entries.length); entries.push({ name, type: 2, data }); }
  if (sub) {
    const id = entries.length;
    entries[0]!.children!.push(id);
    entries.push({ name: sub[0], type: 1, children: [] });
    for (const [name, data] of sub[1]) { entries[id]!.children!.push(entries.length); entries.push({ name, type: 2, data }); }
  }
  // Mini stream: every stream is small; 64-byte mini sectors chained in order.
  const mini: Buffer[] = [], miniFat: number[] = [], starts = new Map<number, number>();
  entries.forEach((e, i) => {
    if (e.type !== 2 || e.data!.length === 0) return;
    if (e.data!.length >= 4096) throw new Error("test streams must be small");
    const first = miniFat.length;
    const count = Math.ceil(e.data!.length / 64);
    for (let k = 0; k < count; k++) miniFat.push(k === count - 1 ? 0xfffffffe : first + k + 1);
    const padded = Buffer.alloc(count * 64); e.data!.copy(padded);
    mini.push(padded);
    starts.set(i, first);
  });
  const miniStream = Buffer.concat(mini);
  const sectors = (b: Buffer) => Math.max(1, Math.ceil(b.length / 512));
  const dirBuf = Buffer.alloc(Math.ceil(entries.length / 4) * 512);
  const miniFatBuf = Buffer.alloc(Math.max(512, Math.ceil(miniFat.length * 4 / 512) * 512), 0xff);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v, i * 4));
  const nFat = 1;
  const layout = { fat: 0, dir: nFat, miniFat: nFat + sectors(dirBuf), mini: nFat + sectors(dirBuf) + sectors(miniFatBuf) };
  const total = layout.mini + (miniStream.length ? sectors(miniStream) : 0);
  const fat = Buffer.alloc(512, 0xff);
  const chain = (start: number, n: number) => { for (let k = 0; k < n; k++) fat.writeUInt32LE(k === n - 1 ? 0xfffffffe : start + k + 1, (start + k) * 4); };
  fat.writeUInt32LE(0xfffffffd, 0);
  chain(layout.dir, sectors(dirBuf));
  chain(layout.miniFat, sectors(miniFatBuf));
  if (miniStream.length) chain(layout.mini, sectors(miniStream));
  if (total > 128) throw new Error("test file too large for one FAT sector");
  entries.forEach((e, i) => {
    const at = i * 128;
    const n = Buffer.from(e.name + "\0", "utf16le");
    n.copy(dirBuf, at);
    dirBuf.writeUInt16LE(n.length, at + 0x40);
    dirBuf[at + 0x42] = e.type; dirBuf[at + 0x43] = 1;
    dirBuf.writeUInt32LE(0xffffffff, at + 0x44); dirBuf.writeUInt32LE(0xffffffff, at + 0x48); dirBuf.writeUInt32LE(0xffffffff, at + 0x4c);
    if (e.type === 5) { dirBuf.writeUInt32LE(miniStream.length ? layout.mini : 0xfffffffe, at + 0x74); dirBuf.writeUInt32LE(miniStream.length, at + 0x78); }
    if (e.type === 2) { dirBuf.writeUInt32LE(starts.get(i) ?? 0xfffffffe, at + 0x74); dirBuf.writeUInt32LE(e.data!.length, at + 0x78); }
    if (e.type === 1 || e.type === 5) createHash("md5").update("clsid:" + e.name).digest().copy(dirBuf, at + 0x50); // fixed, so a rebuild is identical
  });
  // Siblings as a right-leaning list under each storage (a valid, if unbalanced, tree).
  for (const e of entries.filter(x => x.children?.length)) {
    const kids = e.children!;
    dirBuf.writeUInt32LE(kids[0]!, entries.indexOf(e) * 128 + 0x4c);
    for (let k = 0; k < kids.length - 1; k++) dirBuf.writeUInt32LE(kids[k + 1]!, kids[k]! * 128 + 0x48);
  }
  const header = Buffer.alloc(512);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18); header.writeUInt16LE(3, 0x1a); header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e); header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(nFat, 0x2c); header.writeUInt32LE(layout.dir, 0x30); header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(layout.miniFat, 0x3c); header.writeUInt32LE(sectors(miniFatBuf), 0x40);
  header.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 0x4c + i * 4);
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(sectors(b) * 512 - b.length)]);
  return Buffer.concat([header, fat, pad(dirBuf), pad(miniFatBuf), ...(miniStream.length ? [pad(miniStream)] : [])]);
}

export function writeFolder(files: Record<string, Buffer | string>): string {
  const dir = tempDir();
  for (const [name, data] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), data); }
  return dir;
}
